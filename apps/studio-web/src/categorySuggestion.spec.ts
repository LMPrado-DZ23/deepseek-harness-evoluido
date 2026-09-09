import { describe, expect, it } from 'vitest'
import { categoryGuess, suggestCategory, DEFAULT_CATEGORY } from './categorySuggestion'
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

describe('C-N4: o palpite diz quando NÃO entendeu', () => {
  it('separa "entendi página de apresentação" de "não entendi nada"', () => {
    // As duas saídas eram indistinguíveis: `landing-page` tanto para quem
    // descreve uma página quanto para quem escreve algo que este palpite não
    // reconhece. A tela, por cima, afirmava "Entendemos isto pelo seu texto" —
    // e uma afirmação falsa dessas convence a pessoa a NÃO corrigir.
    expect(categoryGuess('uma página para divulgar meu trabalho')).toMatchObject({ category: 'landing-page', understood: true })
    for (const vago of ['', '   ', 'asdf qwer', 'quero um negócio', 'me ajuda aí', 'preciso de uma coisa']) {
      expect(categoryGuess(vago), vago).toMatchObject({ category: 'landing-page', understood: false })
    }
  })
})

describe('C-2 (2ª passada): o texto de quem escreve rápido e errado', () => {
  // Amostra da auditoria: 19 de 20 destes não pontuavam NADA. Os que estão
  // dentro do que o Studio constrói passaram a ser entendidos; os que estão
  // FORA continuam "não entendi", que é a resposta honesta — o produto não
  // sabe fazer entrega, chat nem rede social, e fingir que entendeu mandaria a
  // pessoa para o gerador errado.
  it('entende pedido curto, com erro de grafia e sem acento', () => {
    const expected = [
      ['salao de beleza, cliente escolhe dia e hora com a manicure', 'scheduling'],
      ['quero q as pessoa marque hora comigo pelo celular', 'scheduling'],
      ['AJENDA PRA MINHA CLINICA', 'scheduling'],
      ['controle de ordens de servico da oficina, mexer nos dados', 'crud-panel'],
      ['saber quanto entrou e quanto saiu por semana', 'dashboard'],
      ['controle financeiro do meu mei', 'dashboard'],
      ['axo q preciso d um lugar pra guarda os nome dos meu cliente', 'form-database'],
      ['preciso controlar quem me deve', 'form-database'],
      ['sistema de ponto dos funcionarios', 'form-database'],
      ['quero registrar as horas que trabalhei em cada obra', 'form-database'],
    ] as const
    for (const [brief, category] of expected) {
      const guess = categoryGuess(brief)
      expect(guess, brief).toMatchObject({ category, understood: true, basis: 'text' })
    }
  })

  // O RAMO é um ponto de partida, nunca uma afirmação de entendimento. Quem
  // escreve só o ofício - "sistema pra barbearia" - não disse o que o
  // aplicativo faz; o Studio deixa de mandar essa pessoa para uma página de
  // apresentação, e continua dizendo que não entendeu o pedido.
  it('usa o ramo como ponto de partida sem afirmar que entendeu', () => {
    const expected = [
      ['sistema pra barbearia', 'scheduling'],
      ['app de delivery', 'catalog'],
      ['preciso de algo pro meu consultorio', 'scheduling'],
      ['quero um sistema pra pizzaria', 'catalog'],
    ] as const
    for (const [brief, category] of expected) {
      expect(categoryGuess(brief), brief).toMatchObject({ category, understood: false, basis: 'trade' })
    }
  })

  it('não finge entender o que o Studio não constrói', () => {
    for (const fora of ['app de delivery', 'rede social pra minha igreja', 'quero um chat com meus clientes', 'loja virtual com carrinho e pagamento']) {
      expect(categoryGuess(fora).understood, fora).toBe(false)
    }
  })
})

describe('o que a medição do conjunto cego trouxe à tona', () => {
  it('não entender é DIFERENTE de achar que é página de apresentação', () => {
    // O palpite devolve `landing-page` nos dois casos, porque é o padrão. A
    // diferença mora em `understood`/`basis` — e é ela que decide se a tela
    // pergunta ou assume. Em 21 pedidos escritos com outras palavras, 8
    // caíram aqui.
    const unknown = categoryGuess('preciso de uma coisa para resolver o dia a dia da empresa')
    expect(unknown.understood).toBe(false)
    expect(unknown.basis).toBe('none')

    const understood = categoryGuess('quero um catálogo para mostrar meus produtos')
    expect(understood.understood).toBe(true)
    expect(understood.basis).toBe('text')
  })

  it('texto vazio nunca afirma ter entendido', () => {
    expect(categoryGuess('   ').understood).toBe(false)
  })

  it('o ramo sozinho não vira certeza', () => {
    // Reconhecer "clínica" diz o ramo, não o que o aplicativo faz. Afirmar
    // compreensão aqui convenceria a pessoa a não corrigir.
    const guess = categoryGuess('tenho uma clínica')
    expect(guess.basis).toBe('trade')
    expect(guess.understood).toBe(false)
  })
})
