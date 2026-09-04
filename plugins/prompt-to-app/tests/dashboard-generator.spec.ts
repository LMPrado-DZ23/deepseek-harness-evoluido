import { describe, expect, it } from 'vitest'
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import type { AppSpecV1 } from '../src/appspec.js'
import {
  DashboardCategoryError,
  generateDashboardLayer,
  summarizeDashboardRows,
} from '../src/dashboard-generator.js'

const dashboardSpec: AppSpecV1 = {
  schema_version: 1,
  problem: 'Acompanhar os pedidos cadastrados pela equipe.',
  audience: 'Equipe de atendimento',
  journeys: ['Consultar indicadores sem alterar os cadastros'],
  pages: [{ name: 'Painel', sections: ['Resumo', 'Situação', 'Evolução mensal'] }],
  entities: [{
    name: 'Pedido',
    kind: 'database',
    sensitive: false,
    fields: [
      { name: 'Cliente', type: 'text', required: true },
      { name: 'Situação', type: 'selection', required: false, options: ['Novo', 'Concluído'] },
      { name: 'Criado em', type: 'date', required: false },
      { name: 'Canal', type: 'selection', required: false, options: ['Site', 'Telefone'] },
      { name: 'Entrega', type: 'date', required: false },
    ],
  }],
  sensitive_data: { detected: [], confirmed_by_user: false },
  accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true },
  language: 'pt-BR',
  acceptance_criteria: ['O painel mostra os registros sem permitir alterações.'],
}

describe('deterministic dashboard generator', () => {
  it('aggregates total, first selection and first date without hiding missing values', () => {
    const summary = summarizeDashboardRows([
      { situacao: 'Novo', criado_em: '2026-09-04' },
      { situacao: 'Concluído', criado_em: '2026-08-31' },
      { situacao: 'novo', criado_em: '2026-09-19T09:30:00Z' },
      { situacao: '', criado_em: 'invalid-date' },
    ], 'situacao', 'criado_em')

    expect(summary).toEqual({
      total: 4,
      bySelection: [
        { key: 'concluído', label: 'Concluído', count: 1 },
        { key: 'novo', label: 'Novo', count: 2 },
        { key: '__missing__', label: 'Não informado', count: 1 },
      ],
      byMonth: [
        { key: '2026-08', label: 'agosto de 2026', count: 1 },
        { key: '2026-09', label: 'setembro de 2026', count: 2 },
        { key: '__missing__', label: 'Data não informada', count: 1 },
      ],
    })
  })

  it('returns honest empty aggregates', () => {
    expect(summarizeDashboardRows([], 'situacao', 'criado_em')).toEqual({
      total: 0,
      bySelection: [],
      byMonth: [],
    })
    expect(summarizeDashboardRows([{ name: 'A' }])).toEqual({ total: 1, bySelection: [], byMonth: [] })
  })

  it('keeps malformed and absent values visible instead of counting them as valid dates', () => {
    const summary = summarizeDashboardRows([
      { status: 'B', when: undefined },
      { status: 'A', when: '2026-13-01' },
      { status: null, when: 'not-a-date' },
    ], 'status', 'when')
    expect(summary.bySelection).toEqual([
      { key: 'a', label: 'A', count: 1 },
      { key: 'b', label: 'B', count: 1 },
      { key: '__missing__', label: 'Não informado', count: 1 },
    ])
    expect(summary.byMonth).toEqual([
      { key: '__missing__', label: 'Data não informada', count: 3 },
    ])
    expect(summarizeDashboardRows([
      { status: null }, { status: 'B' }, { status: 'A' },
    ], 'status').bySelection.map(bucket => bucket.key)).toEqual(['a', 'b', '__missing__'])
  })

  it('generates an authenticated read-only panel using only the first eligible fields', () => {
    const layer = generateDashboardLayer(dashboardSpec, 'dashboard')
    expect(layer.files.map(file => file.path)).toEqual([
      'src/components/generated/dashboards/pedido-dashboard.tsx',
      'src/components/generated/dashboards/index.ts',
    ])
    expect(layer.protectedPaths).toEqual(layer.files.map(file => file.path))

    const component = layer.files[0]!.content
    expect(component).toContain('const session=await currentSession()')
    expect(component).toContain('if(session===null)return <AccessPanel/>')
    expect(component).toContain("grouped(rows,\"situacao\",'selection')")
    expect(component).toContain("grouped(rows,\"criado_em\",'month')")
    expect(component).not.toContain('"canal"')
    expect(component).not.toContain('"entrega"')
    expect(component).toContain('"empty":"Ainda não há dados suficientes para este painel."')
    expect(component).not.toMatch(/\b(?:create|update|delete|fetch|WebSocket|XMLHttpRequest)\s*\(/u)
    expect(component).not.toContain('<form')
    expect(component).not.toContain('<button')
    expect(component).not.toContain('http://')
    expect(component).not.toContain('https://')
    const transpiled = transpileModule(component, {
      compilerOptions: { jsx: JsxEmit.Preserve, module: ModuleKind.NodeNext, target: ScriptTarget.ES2023 },
      reportDiagnostics: true,
      fileName: 'pedido-dashboard.tsx',
    })
    expect(transpiled.diagnostics ?? []).toEqual([])
  })

  it('declares a static accessible table equivalent for the decorative SVG', () => {
    const component = generateDashboardLayer(dashboardSpec, 'dashboard').files[0]!.content
    expect(component).toContain('<svg aria-hidden="true" focusable="false"')
    expect(component).toContain("<table><caption>{message(copy.groupCaption,{__FIELD__:title})}</caption>")
    expect(component).toContain('<th scope="col">')
    expect(component).toContain('<th scope="row">')
    expect(component).toContain('<p role="status">{copy.empty}</p>')
    // This verifies the generated markup contract only; browser and assistive-technology E2E remain separate evidence.
  })

  it('omits unavailable groupings and gives each generated section a stable entity-scoped id', () => {
    const noGroups: AppSpecV1 = {
      ...dashboardSpec,
      entities: [{ name: 'Nota', kind: 'database', sensitive: false, fields: [{ name: 'Texto', type: 'text', required: true }] }],
    }
    const component = generateDashboardLayer(noGroups, 'dashboard').files[0]!.content
    expect(component).toContain("grouped(rows,undefined,'selection')")
    expect(component).toContain("grouped(rows,undefined,'month')")
    expect(component).toContain('aria-labelledby="nota-dashboard-summary"')
    expect(component).toContain('id="nota-dashboard-selection"')
    expect(component).toContain('id="nota-dashboard-month"')
  })

  it('does not generate for another category and rejects dashboards without stored data', () => {
    expect(generateDashboardLayer(dashboardSpec, 'catalog')).toEqual({ files: [], protectedPaths: [] })
    const withoutDatabase: AppSpecV1 = { ...dashboardSpec, entities: [] }
    expect(() => generateDashboardLayer(withoutDatabase, 'dashboard')).toThrow(DashboardCategoryError)
  })
})
