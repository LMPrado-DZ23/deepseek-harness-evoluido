import { describe, expect, it } from 'vitest'
import { LIMITE_DO_ERRO, mensagemDaPrevia } from './mensagens.js'
import { rotaDaPrevia } from './navegacao.js'

describe('o que vem da prévia é DADO, nunca instrução', () => {
  /*
    Lá dentro roda código que um modelo escreveu a partir do que uma pessoa
    pediu — e o pedido pode ter vindo de qualquer lugar. A conferência é por
    lista fechada: o que não está no vocabulário não existe, em vez de ser
    aceito por parecer inofensivo.
  */
  const tentativas = [
    { type: 'DZ23_EXEC', command: 'rm -rf /' },
    { type: 'DZ23_PREVIEW_READY', command: 'rm -rf /' },
    { type: 'DZ23_OPEN_PROJECT', project_id: 'outro' },
    { type: 'DZ23_GRANT', scope: 'admin' },
    { type: 'DZ23_PUBLISH' },
    { type: 'DZ23_PREVIEW_ADMISSION', ticket: 'roubado' },
  ]

  it('nenhum tipo desconhecido é reconhecido', () => {
    for (const corpo of tentativas.slice(2)) {
      expect(mensagemDaPrevia(corpo), JSON.stringify(corpo)).toBeNull()
    }
  })

  it('um tipo CONHECIDO não carrega comando junto', () => {
    // A mensagem reconhecida devolve só o que o vocabulário declara; campos
    // extras não atravessam.
    expect(mensagemDaPrevia({ type: 'DZ23_PREVIEW_READY', command: 'rm -rf /' })).toEqual({ tipo: 'PEDIU_ADMISSAO' })
  })

  it('o que não é objeto não é mensagem', () => {
    for (const corpo of [null, undefined, 'DZ23_EXEC', 42, [], true]) {
      expect(mensagemDaPrevia(corpo)).toBeNull()
    }
  })

  it('o vocabulário inteiro tem TRÊS tipos, e nenhum deles autoriza nada', () => {
    const reconhecidas = [
      mensagemDaPrevia({ type: 'DZ23_PREVIEW_READY' }),
      mensagemDaPrevia({ type: 'DZ23_PREVIEW_ROUTE', path: '/jogo' }),
      mensagemDaPrevia({ type: 'DZ23_PREVIEW_ERROR', message: 'quebrou' }),
    ]
    expect(reconhecidas.map(item => item?.tipo)).toEqual(['PEDIU_ADMISSAO', 'MUDOU_DE_ROTA', 'ERRO'])
  })
})

describe('a rota anunciada passa pela MESMA conferência da digitada', () => {
  it('a mensagem entrega o caminho cru — e ele ainda tem de passar', () => {
    /*
      Um aplicativo gerado que anuncie `https://outro.site` moveria o quadro
      para fora sem ninguém ter pedido. O decodificador não confere rota; ele
      entrega o texto, e quem confere é `rotaDaPrevia`.
    */
    const anunciada = mensagemDaPrevia({ type: 'DZ23_PREVIEW_ROUTE', path: 'https://outro.site' })
    expect(anunciada).toEqual({ tipo: 'MUDOU_DE_ROTA', caminho: 'https://outro.site' })
    expect(rotaDaPrevia('https://outro.site').tipo).toBe('RECUSADA')
  })

  it('caminho que não é texto não vira rota', () => {
    expect(mensagemDaPrevia({ type: 'DZ23_PREVIEW_ROUTE', path: { toString: () => '/x' } })).toBeNull()
    expect(mensagemDaPrevia({ type: 'DZ23_PREVIEW_ROUTE' })).toBeNull()
  })
})

describe('o erro da prévia é texto, e é cortado', () => {
  it('um erro enorme não enche a interface', () => {
    const lido = mensagemDaPrevia({ type: 'DZ23_PREVIEW_ERROR', message: 'x'.repeat(LIMITE_DO_ERRO * 4) })
    expect(lido?.tipo).toBe('ERRO')
    expect(lido?.tipo === 'ERRO' ? lido.mensagem.length : 0).toBe(LIMITE_DO_ERRO)
  })

  it('erro que não é texto não vira erro', () => {
    expect(mensagemDaPrevia({ type: 'DZ23_PREVIEW_ERROR', message: { html: '<script>' } })).toBeNull()
  })
})
