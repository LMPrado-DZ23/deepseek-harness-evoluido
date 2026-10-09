import { describe, expect, it } from 'vitest'
import { TAREFAS_NO_TRILHO, iniciaisDaConta, tarefasDoTrilho } from './tarefasDoTrilho'

const HREF = 'http://studio.local/studio/'

function tarefa(id: string, updated_at?: string) {
  return { project_id: id, name: `Tarefa ${id}`, state: 'VERIFIED_PROTOTYPE', ...(updated_at === undefined ? {} : { updated_at }) }
}

describe('as tarefas recentes da lateral', () => {
  it('vêm da mais recente para a mais antiga', () => {
    const lista = tarefasDoTrilho([
      tarefa('a', '2026-09-17T10:00:00.000Z'),
      tarefa('c', '2026-09-17T12:00:00.000Z'),
      tarefa('b', '2026-09-17T11:00:00.000Z'),
    ], null, HREF)
    expect(lista.map(item => item.id)).toEqual(['c', 'b', 'a'])
  })

  it('corta no limite, para a lateral não virar a lista inteira', () => {
    const muitas = Array.from({ length: TAREFAS_NO_TRILHO + 4 }, (_, indice) =>
      tarefa(String(indice), `2026-09-1${String(indice % 9)}T10:00:00.000Z`))
    expect(tarefasDoTrilho(muitas, null, HREF)).toHaveLength(TAREFAS_NO_TRILHO)
  })

  it('marca a tarefa ABERTA, e só ela', () => {
    const lista = tarefasDoTrilho([tarefa('a'), tarefa('b')], 'b', HREF)
    expect(lista.filter(item => item.aberta).map(item => item.id)).toEqual(['b'])
  })

  it('o link leva à tarefa pelo endereço que a tela já sabe restaurar', () => {
    const [primeira] = tarefasDoTrilho([tarefa('proj-1')], null, HREF)
    expect(primeira?.href).toContain('proj-1')
  })

  it('tarefa sem nome mostra o identificador em vez de uma linha vazia', () => {
    // Uma linha em branco na lateral faz a pessoa achar que perdeu o trabalho.
    const [primeira] = tarefasDoTrilho([{ project_id: 'proj-9', name: '   ', state: 'DRAFT' }], null, HREF)
    expect(primeira?.nome).toBe('proj-9')
  })

  it('tarefa sem instante não inventa data nem embaralha a ordem', () => {
    const lista = tarefasDoTrilho([tarefa('a'), tarefa('b'), tarefa('c')], null, HREF)
    expect(lista.map(item => item.id)).toEqual(['a', 'b', 'c'])
  })

  it('lista vazia é lista vazia, e não uma linha de exemplo', () => {
    expect(tarefasDoTrilho([], null, HREF)).toEqual([])
  })
})

describe('as iniciais da conta', () => {
  it('nome com sobrenome usa a primeira e a última', () => {
    expect(iniciaisDaConta('Leandro Marcos Prado')).toBe('LP')
  })

  it('e-mail usa só a parte antes do arroba', () => {
    // "ZE", de zodyprado e exemplo, seria a inicial de um domínio.
    expect(iniciaisDaConta('zody.prado@exemplo.com')).toBe('ZP')
  })

  it('um nome só rende uma letra', () => {
    expect(iniciaisDaConta('Prado')).toBe('P')
  })

  it('sem nome NÃO inventa inicial', () => {
    // Um avatar com uma letra que não é de ninguém é pior que um símbolo.
    expect(iniciaisDaConta(null)).toBeNull()
    expect(iniciaisDaConta('   ')).toBeNull()
    expect(iniciaisDaConta(undefined)).toBeNull()
  })
})
