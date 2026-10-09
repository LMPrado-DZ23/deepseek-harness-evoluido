import { describe, expect, it } from 'vitest'
import { STUDIO_CATEGORIES } from '../categories'
import {
  RASCUNHO_VAZIO,
  TAREFA_VAZIA,
  chaveDoTotal,
  evidenciaDasTarefas,
  limitesDoTexto,
  nomesDasTarefas,
  planoDoRascunho,
  planosIguais,
  rascunhoDoPlano,
  recusaDaEmpresa,
  recusaDaRevisao,
  recusaDaTarefa,
  recusaDoPlano,
  textoDosLimites,
  totalDePacotes,
  textoNormalizado,
  versaoVigente,
  versoesAnteriores,
  type RascunhoDaEmpresa,
} from './empresa'

const PRONTO: RascunhoDaEmpresa = {
  nome: 'Bolos da Ana',
  origem: 'criada',
  identidade: '',
  objetivo: 'vender bolos caseiros por encomenda no bairro',
  publico: 'moradores do bairro',
  oferta: 'bolo de 1kg com 2 dias de antecedência',
  limites: 'não entrega fora do bairro',
}

describe('os limites, um por linha', () => {
  it('linha em branco some, em vez de virar um limite vazio', () => {
    expect(limitesDoTexto('só à vista\n\n   \nnão entrega fora do bairro'))
      .toEqual(['só à vista', 'não entrega fora do bairro'])
  })

  it('duas linhas que só diferem no espaçamento viram UMA', () => {
    // A contagem que a tela mostra tem de ser a que o servidor vai gravar; se
    // divergir, a pessoa vê quatro limites e três aparecem depois.
    expect(limitesDoTexto('só à vista\n  só   à vista ')).toEqual(['só à vista'])
  })

  it('a ORDEM é a que a pessoa escreveu', () => {
    expect(limitesDoTexto('zebra\nabacate')).toEqual(['zebra', 'abacate'])
  })

  it('o caminho de volta preserva o que foi escrito', () => {
    expect(limitesDoTexto(textoDosLimites(['zebra', 'abacate']))).toEqual(['zebra', 'abacate'])
  })

  it('campo vazio não produz limite nenhum', () => {
    expect(limitesDoTexto('')).toEqual([])
  })
})

describe('a normalização', () => {
  it('tira espaço das pontas e junta os repetidos', () => {
    expect(textoNormalizado('  Bolos   da Ana  ')).toBe('Bolos da Ana')
  })
})

describe('por que o cadastro ainda não pode ser enviado', () => {
  it('o rascunho vazio recusa pelo NOME, que é o primeiro campo da tela', () => {
    // Apontar o último problema mandaria quem lê de cima para baixo procurar.
    expect(recusaDaEmpresa(RASCUNHO_VAZIO)).toBe('erroNome')
  })

  it('nome só com espaço é o mesmo que nome vazio', () => {
    expect(recusaDaEmpresa({ ...PRONTO, nome: '   ' })).toBe('erroNome')
  })

  it('com nome, a recusa passa a ser do OBJETIVO', () => {
    expect(recusaDaEmpresa({ ...PRONTO, objetivo: 'vender' })).toBe('erroObjetivo')
  })

  it('objetivo longo e público curto recusa pelo PÚBLICO', () => {
    expect(recusaDaEmpresa({ ...PRONTO, publico: 'eu' })).toBe('erroPublico')
  })

  it('um limite curto demais é recusado ANTES do envio', () => {
    expect(recusaDaEmpresa({ ...PRONTO, limites: 'ok' })).toBe('erroLimiteCurto')
  })

  it('mais de vinte limites é recusado', () => {
    const muitos = Array.from({ length: 21 }, (_, indice) => `limite número ${indice}`).join('\n')
    expect(recusaDaEmpresa({ ...PRONTO, limites: muitos })).toBe('erroLimitesDemais')
  })

  it('o rascunho completo não tem recusa', () => {
    expect(recusaDaEmpresa(PRONTO)).toBeNull()
  })

  it('a oferta VAZIA não recusa: ainda não decidido é um estado honesto', () => {
    expect(recusaDoPlano({ ...PRONTO, oferta: '' })).toBeNull()
  })
})

describe('o plano enviado', () => {
  it('vai normalizado, e não como foi digitado', () => {
    expect(planoDoRascunho({ ...PRONTO, publico: '  moradores   do bairro ' }).publico).toBe('moradores do bairro')
  })
})

describe('quando a revisão não muda nada', () => {
  it('o plano IGUAL ao vigente é recusado antes do envio', () => {
    // Sem isto, a única resposta seria um 409 depois do envio, e a pessoa não
    // saberia que nada mudou enquanto ainda estava editando.
    expect(recusaDaRevisao(PRONTO, planoDoRascunho(PRONTO))).toBe('erroSemMudanca')
  })

  it('trocar a ORDEM dos limites não é mudança', () => {
    const vigente = planoDoRascunho({ ...PRONTO, limites: 'zebra\nabacate' })
    expect(recusaDaRevisao({ ...PRONTO, limites: 'abacate\nzebra' }, vigente)).toBe('erroSemMudanca')
  })

  it('ACRESCENTAR um limite é mudança', () => {
    const vigente = planoDoRascunho(PRONTO)
    expect(recusaDaRevisao({ ...PRONTO, limites: `${PRONTO.limites}\nsó à vista` }, vigente)).toBeNull()
  })

  it('a recusa de CONTEÚDO vem antes da de "sem mudança"', () => {
    // Dizer "está igual" para um plano que nem sequer é válido mandaria a
    // pessoa mudar o campo errado.
    expect(recusaDaRevisao({ ...PRONTO, objetivo: 'ir' }, planoDoRascunho(PRONTO))).toBe('erroObjetivo')
  })

  it('o rascunho da revisão abre com o plano vigente', () => {
    const vigente = planoDoRascunho({ ...PRONTO, limites: 'zebra\nabacate' })
    expect(rascunhoDoPlano(vigente).limites).toBe('zebra\nabacate')
  })

  it('dois planos idênticos são iguais, e um campo diferente já não é', () => {
    const plano = planoDoRascunho(PRONTO)
    expect(planosIguais(plano, plano)).toBe(true)
    expect(planosIguais(plano, { ...plano, oferta: 'bolo de 2kg' })).toBe(false)
  })
})

describe('a versão vigente do plano', () => {
  const v = (version: number) => ({ version })

  it('é a de maior VERSÃO, e não a última da lista', () => {
    // Dois registros no mesmo milissegundo empatariam por data, e a ordem de
    // leitura decidiria qual plano a empresa tem.
    expect(versaoVigente([v(2), v(3), v(1)])?.version).toBe(3)
  })

  it('sem versão nenhuma, não inventa uma', () => {
    expect(versaoVigente([])).toBeUndefined()
  })

  it('o histórico anterior exclui a vigente e vai da mais nova para a mais antiga', () => {
    expect(versoesAnteriores([v(2), v(3), v(1)]).map(registro => registro.version)).toEqual([2, 1])
  })

  it('com uma versão só, não há histórico anterior', () => {
    expect(versoesAnteriores([v(1)])).toEqual([])
  })
})

describe('por que a tarefa da empresa ainda não pode ser criada', () => {
  it('pedido vazio é recusado ANTES do envio', () => {
    // Um botão ligado que recusa depois ensina a pessoa a desconfiar do produto.
    expect(recusaDaTarefa(TAREFA_VAZIA)).toBe('erroPedido')
  })

  it('pedido só com espaço é o mesmo que vazio', () => {
    expect(recusaDaTarefa({ ...TAREFA_VAZIA, pedido: '   ' })).toBe('erroPedido')
  })

  it('um pedido de verdade não tem recusa', () => {
    expect(recusaDaTarefa({ ...TAREFA_VAZIA, pedido: 'uma página para encomendas' })).toBeNull()
  })

  it('o tipo padrão é uma das categorias que a TAREFA conhece', () => {
    // Um valor que o domínio da tarefa não conhece faria o primeiro envio
    // voltar 400 sem que ninguém tivesse escolhido nada errado.
    expect(STUDIO_CATEGORIES).toContain(TAREFA_VAZIA.category)
  })
})

describe('o nome de cada tarefa vinculada', () => {
  const projetos = [{ project_id: 'p-1', name: 'Página de encomendas' }, { project_id: 'p-2', name: 'Catálogo' }]

  it('vem de quem é DONO do nome, e na ordem dos vínculos', () => {
    // Gravar o nome dentro do vínculo criaria uma cópia que envelhece na
    // primeira vez que alguém renomeasse a tarefa.
    expect(nomesDasTarefas([{ project_id: 'p-2' }, { project_id: 'p-1' }], projetos))
      .toEqual(['Catálogo', 'Página de encomendas'])
  })

  it('tarefa que a lista não traz vira `null`, e NÃO some nem ganha nome inventado', () => {
    // Esconder a linha apagaria um vínculo que existe; inventar um nome
    // mentiria sobre ele. `null` é a terceira resposta, e é a honesta.
    expect(nomesDasTarefas([{ project_id: 'p-9' }], projetos)).toEqual([null])
  })

  it('sem vínculo nenhum, não há nome nenhum', () => {
    expect(nomesDasTarefas([], projetos)).toEqual([])
  })
})

describe('o que cada tarefa da empresa produziu', () => {
  const pacote = (id: string, projectId: string, created_at: string) => ({
    export_id: id, project_id: projectId, file_name: `${id}.zip`, size_bytes: 10, created_at,
  })

  it('cada pacote fica com a tarefa dele, e não com a lista toda', () => {
    const evidencias = evidenciaDasTarefas(
      [{ project_id: 'p-1' }, { project_id: 'p-2' }],
      [pacote('e-1', 'p-1', '2026-09-17T10:00:00.000Z'), pacote('e-2', 'p-2', '2026-09-17T11:00:00.000Z')],
    )
    expect(evidencias.map(evidencia => evidencia.pacotes.map(p => p.export_id))).toEqual([['e-1'], ['e-2']])
  })

  it('os pacotes vêm do mais RECENTE para o mais antigo', () => {
    const evidencias = evidenciaDasTarefas([{ project_id: 'p-1' }], [
      pacote('antigo', 'p-1', '2026-09-16T10:00:00.000Z'),
      pacote('novo', 'p-1', '2026-09-17T10:00:00.000Z'),
    ])
    expect(evidencias[0]!.pacotes.map(p => p.export_id)).toEqual(['novo', 'antigo'])
  })

  it('tarefa SEM pacote continua na lista, com a lista vazia', () => {
    // Esconder a linha faria a empresa parecer ter menos tarefas do que tem.
    const evidencias = evidenciaDasTarefas([{ project_id: 'p-1' }], [])
    expect(evidencias).toHaveLength(1)
    expect(evidencias[0]!.pacotes).toEqual([])
  })

  it('pacote de uma tarefa que NÃO é da empresa não entra', () => {
    const evidencias = evidenciaDasTarefas([{ project_id: 'p-1' }], [pacote('e-9', 'p-outra', '2026-09-17T10:00:00.000Z')])
    expect(evidencias[0]!.pacotes).toEqual([])
  })

  it('o total conta pacotes DISTINTOS, e não a soma das listas', () => {
    // O mesmo pacote lido duas vezes — por duas leituras que se cruzaram —
    // contaria duas na soma.
    const repetido = pacote('e-1', 'p-1', '2026-09-17T10:00:00.000Z')
    expect(totalDePacotes([
      { projectId: 'p-1', pacotes: [repetido] },
      { projectId: 'p-2', pacotes: [repetido] },
    ])).toBe(1)
  })

  it('sem evidência nenhuma, o total é zero', () => {
    expect(totalDePacotes([])).toBe(0)
  })
})

describe('o plural do total de pacotes', () => {
  it('zero NÃO vira frase: cada tarefa já diz que não produziu nada', () => {
    expect(chaveDoTotal(0)).toBeNull()
  })

  it('um é singular, e não "1 pacote(s)"', () => {
    expect(chaveDoTotal(1)).toBe('evidenciaTotalUm')
  })

  it('dois ou mais é plural', () => {
    expect(chaveDoTotal(2)).toBe('evidenciaTotal')
  })
})
