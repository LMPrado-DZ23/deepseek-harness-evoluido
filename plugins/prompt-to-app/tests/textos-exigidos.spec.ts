import { describe, expect, it, vi } from 'vitest'
import { acceptanceChecks, textosExigidos, textosQueFaltaram } from '../src/acceptance.js'
import { ModelCodeGenerator } from '../src/pipeline.js'
import type { AppSpecV1 } from '../src/appspec.js'
import type { StudioPlan } from '../src/model.js'

/*
  Medido em 19/09/2026 no WSL2 do titular: o contador compilou, passou nos
  testes de unidade e reprovou 8 de 18 conferências da tela — todas "o texto
  X não apareceu" —, e o reparo recebeu só "e2e: exit 1".
*/
const spec = {
  schema_version: 1, problem: 'Contar copos de água.', audience: 'Eu', journeys: ['Somar um copo'],
  pages: [{ name: 'Contagem de Copos de Água', sections: ['Contador de Copos', 'Meta de 8 Copos'] }],
  entities: [{ name: 'Contador de Copos', kind: 'app-state', fields: [{ name: 'total_copos', type: 'number', required: true }] }],
  sensitive_data: { detected: [], confirmed_by_user: false },
  accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true }, language: 'pt-BR',
  acceptance_criteria: ['O botão "Somar copo" aumenta o total.', 'Funciona no celular.'],
} as unknown as AppSpecV1

const SAIDA_REAL = [
  '  1) tests/e2e/appspec.spec.ts:15:5 › section:Contador de Copos ──────',
  "    Error: \u001b[31mTimed out 5000ms waiting for \u001b[39m\u001b[2mexpect(\u001b[22m\u001b[31mlocator\u001b[39m",
  "    Locator: getByText('Contador de Copos', { exact: true }).first()",
  "    Locator: getByText('Meta de 8 Copos', { exact: true }).first()",
  "    Locator: getByText('Contador de Copos', { exact: true }).first()",
  "    Locator: getByText('d\\'água', { exact: true }).first()",
].join('\n')

describe('os textos que a verificação procura', () => {
  it('são os nomes de página, seção, entidade e os literais dos critérios, sem repetir', () => {
    expect(textosExigidos(acceptanceChecks(spec))).toEqual([
      'Contagem de Copos de Água', 'Contador de Copos', 'Meta de 8 Copos', 'Somar copo',
    ])
  })

  it('campo de ESTADO e texto dado como EXEMPLO não são exigidos na tela, mas continuam na lista como não conferidos', () => {
    const comExemplo = { ...spec, acceptance_criteria: ['Mostre quanto falta, por exemplo "Faltam 5 copos".', 'Ao chegar a 8, mostre "Meta cumprida!".'] } as unknown as AppSpecV1
    const checks = acceptanceChecks(comExemplo)
    expect(checks.find(check => check.id === 'entity-0-field-0')).toMatchObject({ expected: 'total_copos', status: 'NOT_AUTOMATED' })
    expect(checks.find(check => check.id === 'criterion-0')).toMatchObject({ status: 'NOT_AUTOMATED' })
    expect(checks.find(check => check.id === 'criterion-1')).toMatchObject({ expected: 'Meta cumprida!', status: 'PENDING' })
    const banco = { ...spec, entities: [{ name: 'Pedido', kind: 'database', fields: [{ name: 'cliente', type: 'text', required: true }] }] } as unknown as AppSpecV1
    expect(acceptanceChecks(banco).find(check => check.id === 'entity-0-field-0')).toMatchObject({ status: 'PENDING' })
  })

  it('o que faltou é lido da saída real do Playwright, com as cores removidas', () => {
    expect(textosQueFaltaram(SAIDA_REAL)).toEqual(['Contador de Copos', 'Meta de 8 Copos', "d'água"])
    expect(textosQueFaltaram('nada aqui')).toEqual([])
  })

  it('o prompt do gerador já leva a lista, antes de qualquer reprovação', async () => {
    const prompts: string[] = []
    const modelo = { complete: vi.fn(async (_a: unknown, _b: unknown, _c: unknown, texto: string) => { prompts.push(texto); return { value: JSON.stringify({ files: [{ path: 'src/GeneratedApp.tsx', content: 'export const A = () => null' }] }), route: 'ollama', model: 'm' } }) }
    await new ModelCodeGenerator(modelo as never, { orgId: 'o', tenantId: 't' } as never, 'melhor-qualidade', 'interativo').generate(spec, { slices: [] } as unknown as StudioPlan)
    expect(prompts[0]).toContain('EXATAMENTE assim')
    expect(prompts[0]).toContain('"Contador de Copos","Meta de 8 Copos"')
  })
})
