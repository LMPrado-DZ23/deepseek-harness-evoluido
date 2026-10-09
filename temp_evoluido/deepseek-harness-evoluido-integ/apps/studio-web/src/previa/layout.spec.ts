import { describe, expect, it } from 'vitest'
import {
  DIVISAO_PADRAO, LARGURA_DO_VIEWPORT, MAXIMO_DA_PREVIA, MINIMO_DA_CONVERSA, MODOS, PASSO_DO_DIVISOR, VIEWPORTS,
  divisaoUtil, faceNoCelular, passoDoDivisor, proximoLayout, refComposto, type AcaoDeLayout, type EstadoDoPainel,
} from './layout.js'

const inicial: EstadoDoPainel = {
  modo: 'dividido', tarefaId: 'tarefa-1', rascunho: 'quero uma casa a mais no tabuleiro',
  posicaoDeLeitura: 1280, divisao: DIVISAO_PADRAO, viewport: 'desktop',
}

const TODAS: readonly AcaoDeLayout[] = [
  { tipo: 'abrir' }, { tipo: 'fechar' }, { tipo: 'expandir' }, { tipo: 'restaurar' },
  { tipo: 'alternar' }, { tipo: 'redimensionar', divisao: 0.6 }, { tipo: 'viewport', viewport: 'celular' },
]

describe('o layout não pode encostar na tarefa', () => {
  it('NENHUMA ação de layout perde rascunho, posição de leitura ou identidade da tarefa', () => {
    /*
      A garantia é ESTRUTURAL, e é por isso que ela cabe num teste curto: a
      função de layout não recebe execução nem prévia, então não tem como
      cancelar nem parar nada. O que ela poderia perder é o que a pessoa
      escreveu — e a varredura é sobre TODAS as ações, não sobre exemplos.
    */
    for (const acao of TODAS) {
      const depois = proximoLayout(inicial, acao)
      expect(depois.tarefaId, `${acao.tipo} perdeu a tarefa`).toBe(inicial.tarefaId)
      expect(depois.rascunho, `${acao.tipo} perdeu o rascunho`).toBe(inicial.rascunho)
      expect(depois.posicaoDeLeitura, `${acao.tipo} perdeu a posição de leitura`).toBe(inicial.posicaoDeLeitura)
    }
  })

  it('fechar o painel NÃO é parar a prévia nem cancelar a tarefa', () => {
    // Três operações, três efeitos. Esta função só sabe fazer a primeira.
    const fechado = proximoLayout(inicial, { tipo: 'fechar' })
    expect(fechado.modo).toBe('fechado')
    expect(Object.keys(fechado).sort()).toEqual(Object.keys(inicial).sort())
  })

  it('reabrir devolve o modo DIVIDIDO, e não o expandido de antes', () => {
    // Expandir é pedido momentâneo; herdá-lo esconderia a conversa de quem só
    // quis ver o aplicativo de novo.
    const expandido = proximoLayout(inicial, { tipo: 'expandir' })
    const fechado = proximoLayout(expandido, { tipo: 'fechar' })
    expect(proximoLayout(fechado, { tipo: 'abrir' }).modo).toBe('dividido')
  })

  it('alternar vai e volta entre fechado e dividido', () => {
    const uma = proximoLayout(inicial, { tipo: 'alternar' })
    expect(uma.modo).toBe('fechado')
    expect(proximoLayout(uma, { tipo: 'alternar' }).modo).toBe('dividido')
  })
})

describe('a divisão tem limites, e eles não são estéticos', () => {
  it('abaixo do mínimo da conversa, o compositor deixa de caber', () => {
    expect(divisaoUtil(0.05)).toBe(MINIMO_DA_CONVERSA)
  })

  it('acima do máximo, o quadro fica menor que o aparelho que ele diz emular', () => {
    expect(divisaoUtil(0.95)).toBe(MAXIMO_DA_PREVIA)
  })

  it('um número que não é número volta ao padrão, em vez de virar NaN na folha de estilo', () => {
    expect(divisaoUtil(Number.NaN)).toBe(DIVISAO_PADRAO)
    expect(divisaoUtil(Number.POSITIVE_INFINITY)).toBe(DIVISAO_PADRAO)
  })

  it('o arrasto dentro da faixa passa intacto', () => {
    expect(proximoLayout(inicial, { tipo: 'redimensionar', divisao: 0.6 }).divisao).toBe(0.6)
  })
})

describe('desktop e celular mudam o viewport de verdade', () => {
  it('o celular tem largura, e o desktop NÃO tem uma inventada', () => {
    /*
      Fingir uma largura no desktop faria a prévia mentir sobre o espaço que o
      aplicativo realmente tem. `null` é "ocupe o que houver".
    */
    expect(LARGURA_DO_VIEWPORT.celular).toBeGreaterThan(0)
    expect(LARGURA_DO_VIEWPORT.desktop).toBeNull()
  })

  it('todo viewport declarado tem uma largura declarada', () => {
    for (const viewport of VIEWPORTS) expect(LARGURA_DO_VIEWPORT).toHaveProperty(viewport)
  })

  it('a escolha do viewport sobrevive a abrir, fechar e expandir', () => {
    const celular = proximoLayout(inicial, { tipo: 'viewport', viewport: 'celular' })
    for (const acao of TODAS.filter(item => item.tipo !== 'viewport')) {
      expect(proximoLayout(celular, acao).viewport).toBe('celular')
    }
  })
})

describe('no celular há troca, e não divisão', () => {
  it('com o painel fechado, quem aparece é a CONVERSA', () => {
    expect(faceNoCelular('fechado')).toBe('conversa')
  })

  it('dividido e expandido mostram a PRÉVIA por inteiro', () => {
    // Espremer três colunas em 390 pontos produz uma conversa ilegível ao lado
    // de uma prévia ilegível.
    expect(faceNoCelular('dividido')).toBe('previa')
    expect(faceNoCelular('expandido')).toBe('previa')
  })

  it('todo modo declarado tem uma face', () => {
    for (const modo of MODOS) expect(['conversa', 'previa']).toContain(faceNoCelular(modo))
  })
})

describe('o divisor responde ao TECLADO, e não só ao arrasto', () => {
  /*
    Quem navega por teclado não arrasta. Esta descrição existe por causa de uma
    sabotagem que SOBREVIVEU: enquanto o passo era um ternário dentro do
    `onKeyDown`, zerá-lo não quebrava teste nenhum.
  */
  it('as setas movem, e o passo tem sinal', () => {
    expect(passoDoDivisor('ArrowLeft')).toBe(-PASSO_DO_DIVISOR)
    expect(passoDoDivisor('ArrowRight')).toBe(PASSO_DO_DIVISOR)
  })

  it('qualquer outra tecla não mexe em nada', () => {
    for (const tecla of ['ArrowUp', 'ArrowDown', 'Enter', ' ', 'a', 'Tab', 'Escape']) {
      expect(passoDoDivisor(tecla), tecla).toBe(0)
    }
  })

  it('o passo, aplicado, continua dentro dos limites úteis', () => {
    // Dez setas para a direita não passam do máximo: quem corta é `divisaoUtil`,
    // e é ela que o consumidor chama.
    let divisao = DIVISAO_PADRAO
    for (let vez = 0; vez < 10; vez += 1) divisao = divisaoUtil(divisao + passoDoDivisor('ArrowRight'))
    expect(divisao).toBe(MAXIMO_DA_PREVIA)
  })
})

describe('o quadro tem DOIS donos, e o de dentro nunca é desligado', () => {
  /*
    O defeito que este bloco fixa foi achado por REVISÃO EXTERNA, lendo o
    código: `ref={refDoQuadro ?? quadro}` desliga o ref de dentro sempre que
    alguém passa o de fora — e quem monta o painel no produto sempre passa.

    O efeito não aparece na tela. O quadro desenha, o aplicativo carrega, e duas
    coisas param calladas: a conferência de mensagem passa a comparar contra
    `undefined` e recusa TODAS as mensagens, e o modo de seleção é enviado para
    um quadro que o componente não tem — a seleção visual inteira morre no
    produto montado, funcionando em teste.
  */
  const elemento = { nome: 'o quadro' }

  it('o ref de DENTRO é preenchido mesmo quando vem um de fora', () => {
    const interno: { current: typeof elemento | null } = { current: null }
    const externo: { current: typeof elemento | null } = { current: null }
    refComposto(interno, externo)(elemento)
    expect(interno.current, 'o de dentro ficou vazio: é este o defeito').toBe(elemento)
    expect(externo.current).toBe(elemento)
  })

  it('sem ref de fora, o de dentro continua funcionando', () => {
    const interno: { current: typeof elemento | null } = { current: null }
    for (const externo of [undefined, null]) {
      interno.current = null
      refComposto(interno, externo)(elemento)
      expect(interno.current).toBe(elemento)
    }
  })

  it('um ref de fora em forma de FUNÇÃO também recebe', () => {
    // React aceita as duas formas, e um painel montado com a forma de função
    // não pode perder o elemento.
    const interno: { current: typeof elemento | null } = { current: null }
    const recebidos: (typeof elemento | null)[] = []
    refComposto(interno, valor => recebidos.push(valor))(elemento)
    expect(interno.current).toBe(elemento)
    expect(recebidos).toEqual([elemento])
  })

  it('a DESMONTAGEM limpa os dois', () => {
    // React chama o ref com `null` ao desmontar. Guardar um elemento que saiu
    // do documento faria a conferência de mensagem aceitar um quadro morto.
    const interno: { current: typeof elemento | null } = { current: elemento }
    const externo: { current: typeof elemento | null } = { current: elemento }
    refComposto(interno, externo)(null)
    expect(interno.current).toBeNull()
    expect(externo.current).toBeNull()
  })
})
