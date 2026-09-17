import { describe, expect, it } from 'vitest'
import { chaveDaMudanca, conteudosDistintos, versoesDaTarefa } from './versoes'
import type { ItemDoAcervo } from './acervo'

const projeto = { project_id: 'p-1', name: 'Clínica', state: 'VERIFIED_PROTOTYPE' }

function item(id: string, quando: string, extra: { size?: number; entries?: number; sha?: string } = {}): ItemDoAcervo {
  return {
    projeto,
    registro: {
      export_id: id, project_id: 'p-1', run_id: `run-${id}`,
      file_name: 'prototipo.zip', sha256: extra.sha ?? id.repeat(8).slice(0, 64).padEnd(64, '0'),
      size_bytes: extra.size ?? 1_000, entries: extra.entries ?? 3, created_at: quando,
    },
  }
}

describe('a numeração das versões', () => {
  it('a versão 1 é a MAIS ANTIGA, e não a mais recente', () => {
    // Um número que muda quando chega um pacote novo não serve para conversar:
    // "a versão 2" precisa continuar sendo a mesma coisa amanhã.
    const versoes = versoesDaTarefa([
      item('b', '2026-09-17T12:00:00.000Z'),
      item('a', '2026-09-16T12:00:00.000Z'),
    ])
    expect(versoes.map(versao => [versao.item.registro.export_id, versao.numero]))
      .toEqual([['b', 2], ['a', 1]])
  })

  it('a LEITURA é da mais nova para a mais antiga — o contrário da numeração', () => {
    const versoes = versoesDaTarefa([
      item('a', '2026-09-15T12:00:00.000Z'),
      item('c', '2026-09-17T12:00:00.000Z'),
      item('b', '2026-09-16T12:00:00.000Z'),
    ])
    expect(versoes.map(versao => versao.numero)).toEqual([3, 2, 1])
  })

  it('a VIGENTE é a de maior número, e só ela', () => {
    const versoes = versoesDaTarefa([
      item('a', '2026-09-15T12:00:00.000Z'),
      item('b', '2026-09-16T12:00:00.000Z'),
    ])
    expect(versoes.filter(versao => versao.vigente).map(versao => versao.numero)).toEqual([2])
  })

  it('dois pacotes no MESMO instante têm ordem estável, e não a da lista', () => {
    // Sem desempate, a numeração mudaria entre duas leituras dos mesmos dados.
    const mesmoInstante = '2026-09-17T12:00:00.000Z'
    const numeros = (itens: readonly ItemDoAcervo[]) =>
      versoesDaTarefa(itens).map(versao => [versao.item.registro.export_id, versao.numero])
    expect(numeros([item('b', mesmoInstante), item('a', mesmoInstante)]))
      .toEqual(numeros([item('a', mesmoInstante), item('b', mesmoInstante)]))
  })

  it('uma tarefa com UM pacote tem a versão 1, vigente, sem mudança', () => {
    const versoes = versoesDaTarefa([item('a', '2026-09-17T12:00:00.000Z')])
    expect(versoes).toHaveLength(1)
    expect(versoes[0]!.numero).toBe(1)
    expect(versoes[0]!.vigente).toBe(true)
    expect(versoes[0]!.mudanca).toBeNull()
  })

  it('sem pacote nenhum, não há versão nenhuma', () => {
    expect(versoesDaTarefa([])).toEqual([])
  })
})

describe('o que mudou de uma versão para a anterior', () => {
  it('a diferença é com a ANTERIOR, e não com a primeira', () => {
    const versoes = versoesDaTarefa([
      item('a', '2026-09-15T12:00:00.000Z', { size: 1_000 }),
      item('b', '2026-09-16T12:00:00.000Z', { size: 3_000 }),
      item('c', '2026-09-17T12:00:00.000Z', { size: 3_500 }),
    ])
    expect(versoes[0]!.mudanca?.bytes).toBe(500)
  })

  it('encolher é uma diferença NEGATIVA, e não um valor absoluto', () => {
    // O sinal é a informação: um pacote que encolheu pode ter perdido arquivo.
    const versoes = versoesDaTarefa([
      item('a', '2026-09-16T12:00:00.000Z', { size: 3_000, entries: 5 }),
      item('b', '2026-09-17T12:00:00.000Z', { size: 1_000, entries: 3 }),
    ])
    expect(versoes[0]!.mudanca).toMatchObject({ bytes: -2_000, arquivos: -2 })
  })

  it('conteúdo IDÊNTICO é dito pelo resumo, e não pelo tamanho igual', () => {
    // Um pacote pode trocar de conteúdo sem mudar de tamanho; só o resumo
    // responde isso sem dúvida.
    const mesmo = 'f'.repeat(64)
    const versoes = versoesDaTarefa([
      item('a', '2026-09-16T12:00:00.000Z', { sha: mesmo }),
      item('b', '2026-09-17T12:00:00.000Z', { sha: mesmo }),
    ])
    expect(versoes[0]!.mudanca?.identico).toBe(true)
  })

  it('mesmo TAMANHO com resumo diferente NÃO é idêntico', () => {
    const versoes = versoesDaTarefa([
      item('a', '2026-09-16T12:00:00.000Z', { size: 1_000, sha: 'a'.repeat(64) }),
      item('b', '2026-09-17T12:00:00.000Z', { size: 1_000, sha: 'b'.repeat(64) }),
    ])
    expect(versoes[0]!.mudanca).toMatchObject({ bytes: 0, identico: false })
  })
})

describe('a frase de cada mudança', () => {
  it('a primeira versão diz que é a primeira, e não "não mudou"', () => {
    expect(chaveDaMudanca(null)).toBe('primeira')
  })

  it('IDÊNTICO vem antes de tudo, inclusive de "mesmo tamanho"', () => {
    // Um pacote byte a byte igual tem diferença zero nos dois números, e
    // chamá-lo de "mesmo tamanho" esconderia o fato mais útil.
    expect(chaveDaMudanca({ bytes: 0, arquivos: 0, identico: true })).toBe('identica')
  })

  it('cresceu, encolheu e empatou têm frases diferentes', () => {
    expect(chaveDaMudanca({ bytes: 10, arquivos: 0, identico: false })).toBe('maior')
    expect(chaveDaMudanca({ bytes: -10, arquivos: 0, identico: false })).toBe('menor')
    expect(chaveDaMudanca({ bytes: 0, arquivos: 1, identico: false })).toBe('mesmoTamanho')
  })
})

describe('quantas vezes o produto realmente mudou', () => {
  it('conta CONTEÚDOS distintos, e não pacotes', () => {
    // Duas tentativas que devolveram a mesma saída produziram uma versão só do
    // produto, ainda que sejam dois arquivos no disco.
    const mesmo = 'f'.repeat(64)
    const versoes = versoesDaTarefa([
      item('a', '2026-09-15T12:00:00.000Z', { sha: mesmo }),
      item('b', '2026-09-16T12:00:00.000Z', { sha: mesmo }),
      item('c', '2026-09-17T12:00:00.000Z', { sha: 'c'.repeat(64) }),
    ])
    expect(versoes).toHaveLength(3)
    expect(conteudosDistintos(versoes)).toBe(2)
  })

  it('sem versão nenhuma, são zero conteúdos', () => {
    expect(conteudosDistintos([])).toBe(0)
  })
})
