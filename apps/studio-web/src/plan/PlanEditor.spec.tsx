import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PlanEditor } from './PlanEditor'
import type { PlanView } from './planEdit'

const PLAN: PlanView = {
  revision: 1,
  slices: [
    { slice_id: 's1', title: 'Agenda', description: 'Marcar horário', acceptance_criteria: ['dá para marcar'] },
    { slice_id: 's2', title: 'Contato', description: 'Falar com a loja', acceptance_criteria: ['tem telefone'] },
  ],
}

function render(plan: PlanView) {
  return renderToStaticMarkup(createElement(PlanEditor, {
    plan, submit: async () => {}, approve: async () => {}, reason: '', setReason: () => {}, requestChange: async () => {},
  }))
}

describe('E-03 tela do plano editável', () => {
  it('mostra cada parte com os botões de editar, tirar e mover', () => {
    const html = render(PLAN)
    expect(html).toContain('Editar esta parte')
    expect(html).toContain('Tirar esta parte')
    expect(html).toContain('Subir')
    expect(html).toContain('Descer')
    // O nome da parte entra no rótulo do botão de mover: "Subir" sozinho, repetido
    // em cada linha, não diz a quem lê por leitor de tela o que vai subir.
    expect(html).toContain('aria-label="Subir: Contato"')
  })

  it('diz que os arquivos criados NÃO são editáveis, em vez de deixar a ausência parecer esquecimento', () => {
    expect(render(PLAN)).toContain('definidos pelo Studio')
  })

  it('a primeira parte não sobe e a última não desce', () => {
    const html = render(PLAN)
    // Dois botões desabilitados: subir na primeira, descer na última.
    expect(html.match(/disabled=""/gu)?.length).toBeGreaterThanOrEqual(2)
  })

  it('com uma parte só, tirar fica desabilitado', () => {
    const html = render({ revision: 1, slices: [PLAN.slices[0]!] })
    const remove = html.slice(html.indexOf('Tirar esta parte') - 200, html.indexOf('Tirar esta parte'))
    expect(remove).toContain('disabled')
  })

  it('avisa quando o plano tem alterações da pessoa, e não avisa quando não tem', () => {
    expect(render({ ...PLAN, edited_by_person: true })).toContain('alterações suas')
    expect(render(PLAN)).not.toContain('alterações suas')
  })

  it('aprovar e pedir mudança continuam existindo: editar não substitui nenhum dos dois', () => {
    const html = render(PLAN)
    expect(html).toContain('Aprovar este plano')
    expect(html).toContain('Pedir uma mudança')
  })
})
