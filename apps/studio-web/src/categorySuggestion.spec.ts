import { describe, expect, it } from 'vitest'
import { suggestCategory, DEFAULT_CATEGORY } from './categorySuggestion'
import t from './i18n/pt-BR.json'

describe('C-2: o palpite de categoria', () => {
  it('acerta as sete sugestões prontas do produto', () => {
    // Se o palpite erra o texto que o próprio produto oferece, ele não tem
    // chance com o texto de uma pessoa.
    const expected = [
      [t.idea.landing, 'landing-page'], [t.idea.catalog, 'catalog'],
      [t.idea.formDatabase, 'form-database'], [t.idea.crudPanel, 'crud-panel'],
      [t.idea.scheduling, 'scheduling'], [t.idea.dashboard, 'dashboard'],
      [t.idea.saas, 'saas-authenticated'],
    ] as const
    for (const [brief, category] of expected) expect(suggestCategory(brief), brief).toBe(category)
  })

  it('acerta pedidos escritos com as palavras de quem não é técnico', () => {
    const expected = [
      ['quero uma agenda para minha clínica marcar consultas', 'scheduling'],
      ['preciso remarcar e confirmar horários dos pacientes', 'scheduling'],
      ['uma área com acesso separado para cada cliente meu', 'saas-authenticated'],
      ['quero acompanhar os números do mês em gráficos, sem alterar nada', 'dashboard'],
      ['minha equipe precisa criar, editar e excluir cadastros de alunos', 'crud-panel'],
      ['quero cadastrar meus fornecedores e vê-los em uma lista', 'form-database'],
      ['um cardápio para mostrar meus produtos', 'catalog'],
      ['uma página para divulgar meu trabalho e receber contatos', 'landing-page'],
    ] as const
    for (const [brief, category] of expected) expect(suggestCategory(brief), brief).toBe(category)
  })

  it('não inventa categoria quando o texto não diz e não quebra com texto estranho', () => {
    expect(suggestCategory('')).toBe(DEFAULT_CATEGORY)
    expect(suggestCategory('   ')).toBe(DEFAULT_CATEGORY)
    expect(suggestCategory('asdf qwer zxcv')).toBe(DEFAULT_CATEGORY)
    expect(suggestCategory('AGENDA!!! Marcar CONSULTAS...')).toBe('scheduling')
  })

  it('não confunde o painel que MOSTRA com o painel que EDITA', () => {
    // Os dois começam com "painel". Um só lê; o outro escreve no banco. Errar
    // aqui é entregar poder de apagar dado a quem pediu para acompanhar número.
    expect(suggestCategory('um painel para acompanhar números e agrupamentos')).toBe('dashboard')
    expect(suggestCategory('um painel para a equipe criar, editar e excluir')).toBe('crud-panel')
  })
})
