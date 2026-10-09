import { describe, expect, it } from 'vitest'

import {
  FALHAS, LIMITE_ALIAS, LIMITE_BYTES, PERDAS, TIPOS_SUPORTADOS,
  escreverPacoteDeMarca, lerPacoteDeMarca, matrizDeSuporte,
} from '../src/brand-package.js'

/**
 * EVO-02/03 — AT-117 e AT-118.
 *
 * A AT-118 e a mais importante deste arquivo, e o titulo dela ja diz por que:
 * "pacote de design invalido NAO vira instrucao executavel".
 */
const VERMELHO = { h: 0, s: 84, l: 50 }
const ler = (objeto: unknown, ativos: readonly string[] = []) =>
  lerPacoteDeMarca(JSON.stringify(objeto), { ativosAutorizados: ativos })

describe('AT-118 — pacote invalido nao vira instrucao executavel', () => {
  it('alias CIRCULAR e recusado, e o motivo NOMEIA o no que fecha a volta', () => {
    // O detalhe importa: o ciclo curto aponta QUAL cor fecha a volta, e o
    // encadeamento longo demais diz outra coisa. Sem a deteccao rapida, um
    // ciclo de duas cores so seria pego pelo teto de profundidade — e a pessoa
    // leria "encadeamento longo demais" sobre duas linhas que apontam uma para
    // a outra. A falsificacao que remove a deteccao rapida sobrevivia porque
    // este teste so olhava o NOME da falha.
    const lido = ler({ cor: { a: { $type: 'color', $value: '{cor.b}' }, b: { $type: 'color', $value: '{cor.a}' } } })
    expect(lido.tokens).toEqual([])
    expect(lido.falhas.map(f => f.falha)).toContain('ALIAS_CIRCULAR')
    expect(lido.falhas.map(f => f.detalhe)).toContain('cor.a')
    expect(lido.falhas.every(f => f.detalhe !== undefined && !f.detalhe.includes('longo demais'))).toBe(true)
  })

  it('referencia AUSENTE e outro motivo, e nao o mesmo do ciclo', () => {
    // Ciclo e referencia ausente pedem correcoes diferentes de quem escreveu o
    // pacote. Um "invalido" que nao distingue os dois nao conserta nenhum.
    const lido = ler({ cor: { a: { $type: 'color', $value: '{cor.nao-existe}' } } })
    expect(lido.falhas.map(f => f.falha)).toEqual(['REFERENCIA_AUSENTE'])
    expect(lido.falhas[0]?.detalhe).toBe('cor.nao-existe')
  })

  it('tipo FORA do subconjunto vira PERDA declarada, e nao entra', () => {
    const lido = ler({ espaco: { pequeno: { $type: 'dimension', $value: '4px' } } })
    expect(lido.tokens).toEqual([])
    expect(lido.perdas).toEqual([{ caminho: 'espaco.pequeno', perda: 'TIPO_FORA_DO_SUBCONJUNTO', detalhe: 'dimension' }])
    // E NAO e falha: o pacote continua valido, ele so traz mais do que cabe.
    expect(lido.falhas).toEqual([])
  })

  it('tipo NAO DECLARADO nunca e adivinhado', () => {
    // Adivinhar que `#ff0000` e cor e acertar hoje e errar no dia em que alguem
    // escrever uma sombra. O §46 proibe inventar o que nao foi verificado.
    const lido = ler({ cor: { a: { $value: VERMELHO } } })
    expect(lido.tokens).toEqual([])
    expect(lido.perdas).toEqual([{ caminho: 'cor.a', perda: 'TIPO_NAO_DECLARADO' }])
  })

  it('ativo NAO AUTORIZADO e recusado, e nunca aberto', () => {
    const lido = ler({ marca: { logo: { $type: 'color', $value: VERMELHO, $ativo: 'logo-de-outra-empresa.png' } } }, ['meu-logo.png'])
    expect(lido.falhas).toEqual([{ caminho: 'marca.logo', falha: 'ATIVO_NAO_AUTORIZADO', detalhe: 'logo-de-outra-empresa.png' }])
  })

  it('um caminho que tenta escapar recebe a MESMA resposta: nao autorizado', () => {
    // O pacote nao resolve caminho, entao `../../etc/passwd` nao e um caso
    // especial — ele e so mais um nome que nao esta na lista. E isso e o
    // desenho: nao ha travessia a impedir onde nao ha resolucao de caminho.
    for (const ativo of ['../../etc/passwd', '/etc/shadow', 'file:///etc/hosts', 'http://exemplo/x.png']) {
      const lido = ler({ m: { l: { $type: 'color', $value: VERMELHO, $ativo: ativo } } }, ['meu-logo.png'])
      expect(lido.falhas.map(f => f.falha), ativo).toEqual(['ATIVO_NAO_AUTORIZADO'])
    }
  })

  it('script anexado ao pacote NAO e executado: ele e ignorado como grupo', () => {
    // O pacote e TEXTO. Nao ha `eval`, nao ha `Function`, nao ha require.
    const lido = ler({
      $script: 'process.exit(1)',
      cor: { a: { $type: 'color', $value: VERMELHO, $onLoad: 'fetch("http://x")' } },
    })
    expect(lido.tokens).toHaveLength(1)
    // E a extensao nao padrao e DITA, em vez de sumir.
    expect(lido.perdas).toContainEqual({ caminho: 'cor.a', perda: 'EXTENSAO_NAO_PADRAO', detalhe: '$onLoad' })
  })

  it('JSON quebrado, vazio e nao-objeto sao recusados sem lancar', () => {
    for (const texto of ['{ nao e json', '[]', '"texto"', 'null', '']) {
      const lido = lerPacoteDeMarca(texto, { ativosAutorizados: [] })
      expect(lido.falhas.length, texto).toBeGreaterThan(0)
      expect(lido.tokens, texto).toEqual([])
    }
  })

  it('pacote sem nenhuma cor e recusado, e nao aceito vazio', () => {
    // Um pacote de marca sem marca nenhuma que "importa com sucesso" faria
    // alguem acreditar que a empresa tem identidade aplicada.
    expect(ler({ $empresa: 'acme' }).falhas.map(f => f.falha)).toEqual(['SEM_TOKENS'])
  })

  it('cor que nao e cor e recusada', () => {
    expect(ler({ cor: { a: { $type: 'color', $value: 'vermelho' } } }).falhas.map(f => f.falha)).toEqual(['VALOR_INVALIDO'])
  })

  it('pacote grande demais e recusado ANTES de ser interpretado', () => {
    const enorme = JSON.stringify({ cor: { a: { $type: 'color', $value: VERMELHO, $d: 'x'.repeat(LIMITE_BYTES) } } })
    const lido = lerPacoteDeMarca(enorme, { ativosAutorizados: [] })
    expect(lido.falhas.map(f => f.falha)).toEqual(['JSON_INVALIDO'])
  })

  it('encadeamento longo demais nao trava, e e recusado como ciclo', () => {
    const cores: Record<string, unknown> = {}
    for (let i = 0; i <= LIMITE_ALIAS + 4; i++) cores[`c${String(i)}`] = { $type: 'color', $value: `{cor.c${String(i + 1)}}` }
    const lido = ler({ cor: cores })
    expect(lido.falhas.length).toBeGreaterThan(0)
    expect(lido.tokens).toEqual([])
  })
})

describe('AT-117 — round-trip declara o que suporta e o que perde', () => {
  const pacote = {
    $empresa: 'acme', $versao: 'v1',
    cor: { base: { $type: 'color', $value: VERMELHO }, botao: { $type: 'color', $value: '{cor.base}' } },
    espaco: { pequeno: { $type: 'dimension', $value: '4px' } },
  }

  it('o que entra pelo subconjunto suportado VOLTA igual', () => {
    const ida = ler(pacote)
    expect(ida.tokens.map(t => t.caminho).sort()).toEqual(['cor.base', 'cor.botao'])
    const volta = lerPacoteDeMarca(escreverPacoteDeMarca(ida), { ativosAutorizados: [] })
    expect(volta.tokens).toEqual(ida.tokens)
    expect(volta.empresa).toBe('acme')
    expect(volta.versao).toBe('v1')
  })

  it('o alias e RESOLVIDO na ida, e a perda dele esta na matriz de suporte', () => {
    // Preservar a forma do alias exigiria guardar a arvore original, e ai o que
    // se exporta deixa de ser o que o Studio leu.
    const ida = ler(pacote)
    expect(ida.tokens.find(t => t.caminho === 'cor.botao')?.cor).toEqual(VERMELHO)
    expect(escreverPacoteDeMarca(ida)).not.toContain('{cor.base}')
    expect(matrizDeSuporte().join(' ')).toContain('valor já resolvido')
  })

  it('o que NAO cabe no subconjunto e dito na ida e NAO reaparece na volta', () => {
    // Um exportador que devolvesse o que nao entende estaria prometendo um
    // suporte que nao tem.
    const ida = ler(pacote)
    expect(ida.perdas.map(p => p.caminho)).toContain('espaco.pequeno')
    expect(escreverPacoteDeMarca(ida)).not.toContain('dimension')
  })

  it('a exportacao e ESTAVEL: duas escritas do mesmo pacote sao iguais', () => {
    // Um arquivo que muda de ordem a cada exportacao produz diff falso, e um
    // diff falso ensina quem revisa a nao olhar.
    const ida = ler(pacote)
    expect(escreverPacoteDeMarca(ida)).toBe(escreverPacoteDeMarca(ida))
  })

  it('a matriz de suporte sai das MESMAS constantes que decidem', () => {
    // Uma linha escrita a mao divergiria na primeira mudanca, e a que diverge
    // em silencio e sempre a que alguem le.
    const matriz = matrizDeSuporte().join(' ')
    for (const tipo of TIPOS_SUPORTADOS) expect(matriz).toContain(tipo)
    expect(matriz).toContain(String(LIMITE_ALIAS))
    // E, sobretudo, NAO anuncia o que nao suporta. Uma lista escrita a mao
    // continuaria dizendo `dimension` no dia em que `dimension` deixasse de
    // entrar — e e a frase que diverge em silencio que alguem le.
    for (const naoSuportado of ['dimension', 'fontFamily', 'shadow', 'duration']) {
      expect(matriz, naoSuportado).not.toContain(naoSuportado)
    }
  })

  it('NAO promete conversao universal: um tipo so, e dito', () => {
    // O §47 proibe "prometer React↔Flutter universal". A honestidade aqui e
    // declarar que o subconjunto e pequeno.
    expect(TIPOS_SUPORTADOS).toEqual(['color'])
    expect(matrizDeSuporte().join(' ')).toContain('NÃO entra')
  })
})

describe('as listas de motivos sao fechadas', () => {
  it('toda falha e toda perda tem nome na lista', () => {
    const lido = ler({ cor: { a: { $value: VERMELHO }, b: { $type: 'color', $value: '{cor.x}' } } })
    for (const falha of lido.falhas) expect(FALHAS).toContain(falha.falha)
    for (const perda of lido.perdas) expect(PERDAS).toContain(perda.perda)
  })
})
