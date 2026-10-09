import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LIMITE_DO_TEXTO, MAPAS,
  arquivosDeCodigo, contextoParaOCompositor, elementoSelecionado, origemDoElemento,
} from './selecao.js'

const ROTULOS = {
  noElemento: 'No elemento', naRota: 'Na página', noArquivo: 'No arquivo',
  semArquivo: 'Não consegui determinar em qual arquivo este pedaço foi escrito.',
}

describe('o vocabulário do mapa é o MESMO do plugin', () => {
  it('a lista daqui bate com a de `visual-edit.ts`', () => {
    /*
      A interface não depende do plugin — ela fala com ele por HTTP. O preço de
      declarar o vocabulário duas vezes seria a segunda verdade mais cara deste
      repositório, então ele não é pago: este caso LÊ o arquivo do plugin. Um
      estado novo lá quebra este teste no mesmo dia.
    */
    const fonte = readFileSync(resolve(import.meta.dirname, '../../../../plugins/prompt-to-app/src/visual-edit.ts'), 'utf8')
    const declarado = /export const MAPAS = \[([^\]]+)\]/u.exec(fonte)?.[1] ?? ''
    const doPlugin = [...declarado.matchAll(/'([A-Z_]+)'/gu)].map(achado => achado[1])
    expect(doPlugin.length).toBeGreaterThan(0)
    expect([...MAPAS].sort()).toEqual([...doPlugin].sort())
  })
})

describe('o que vem de dentro do quadro é dado, e passa por lista fechada', () => {
  it('um elemento bem descrito atravessa', () => {
    expect(elementoSelecionado({ tag: 'BUTTON', text: 'Reiniciar', path: '/jogo' }))
      .toEqual({ tag: 'button', texto: 'Reiniciar', rota: '/jogo' })
  })

  it('campo faltando ou de outro tipo não vira elemento', () => {
    for (const corpo of [
      null, 'button', 42, {},
      { tag: 'button' },
      { tag: 'button', text: 'x' },
      { tag: '', text: 'x', path: '/' },
      { tag: 'button', text: { html: '<script>' }, path: '/' },
      { tag: 'button', text: 'x', path: 42 },
    ]) {
      expect(elementoSelecionado(corpo), JSON.stringify(corpo)).toBeNull()
    }
  })

  it('texto enorme é CORTADO — a prévia não enche o compositor', () => {
    const lido = elementoSelecionado({ tag: 'p', text: 'x'.repeat(LIMITE_DO_TEXTO * 5), path: '/' })
    expect(lido?.texto.length).toBe(LIMITE_DO_TEXTO)
  })

  it('campos EXTRA não atravessam — mais campos é mais superfície, não mais informação', () => {
    const lido = elementoSelecionado({ tag: 'button', text: 'x', path: '/', command: 'rm -rf /', projeto: 'outro' })
    expect(Object.keys(lido ?? {}).sort()).toEqual(['rota', 'tag', 'texto'])
  })
})

describe('o mapa não inventa arquivo', () => {
  it('com UM arquivo de código, ele é exato NO ARQUIVO', () => {
    expect(origemDoElemento([{ path: 'src/GeneratedApp.tsx' }, { path: 'content/app.json' }]))
      .toEqual({ mapa: 'EXATO', arquivo: 'src/GeneratedApp.tsx' })
  })

  it('com MAIS DE UM, ele é PARCIAL e não aponta nenhum', () => {
    /*
      Saber que o botão está em algum dos três não é saber em qual. Apontar um
      deles seria escolher no escuro com a confiança de quem sabe — e quem lê o
      aviso "pode não ser exatamente aqui" é justamente quem não tem como julgar.
    */
    const origem = origemDoElemento([{ path: 'src/A.tsx' }, { path: 'src/B.tsx' }])
    expect(origem.mapa).toBe('PARCIAL')
    expect(origem.arquivo).toBeUndefined()
  })

  it('sem arquivo de código nenhum, é AUSENTE', () => {
    expect(origemDoElemento([{ path: 'content/app.json' }])).toEqual({ mapa: 'AUSENTE' })
    expect(origemDoElemento([])).toEqual({ mapa: 'AUSENTE' })
  })

  it('só CÓDIGO conta como origem de tela', () => {
    expect(arquivosDeCodigo([
      { path: 'src/A.tsx' }, { path: 'src/b.ts' }, { path: 'src/c.jsx' }, { path: 'src/d.mjs' },
      { path: 'content/app.json' }, { path: 'leia-me.md' }, { path: 'estilo.css' },
    ])).toEqual(['src/A.tsx', 'src/b.ts', 'src/c.jsx', 'src/d.mjs'])
  })
})

describe('o contexto que vai para o compositor', () => {
  const elemento = { tag: 'button', texto: 'Reiniciar', rota: '/jogo' }

  it('leva o elemento, a rota e o arquivo quando ele é conhecido', () => {
    const texto = contextoParaOCompositor(elemento, { mapa: 'EXATO', arquivo: 'src/GeneratedApp.tsx' }, ROTULOS)
    expect(texto).toContain('<button> "Reiniciar"')
    expect(texto).toContain('/jogo')
    expect(texto).toContain('src/GeneratedApp.tsx')
  })

  it('e DIZ a limitação quando o arquivo não pôde ser determinado', () => {
    // Calar faria a pessoa acreditar que o produto sabe mais do que sabe.
    for (const origem of [{ mapa: 'PARCIAL' } as const, { mapa: 'AUSENTE' } as const]) {
      const texto = contextoParaOCompositor(elemento, origem, ROTULOS)
      expect(texto).toContain(ROTULOS.semArquivo)
      expect(texto).not.toContain('src/')
    }
  })

  it('um mapa PARCIAL que carregue arquivo NÃO o entrega', () => {
    /*
      `origemDoElemento` nunca produz isso, e é por isso que a sabotagem que
      removeu esta conferência SOBREVIVEU. Mas esta função recebe qualquer
      `Origem` — inclusive uma que venha de outro produtor, hoje ou depois —, e
      a regra do plugin é clara: mapa parcial não vira arquivo. A conferência é
      da FUNÇÃO, e não do chamador de hoje.
    */
    const texto = contextoParaOCompositor(elemento, { mapa: 'PARCIAL', arquivo: 'src/Chutado.tsx' }, ROTULOS)
    expect(texto).not.toContain('src/Chutado.tsx')
    expect(texto).toContain(ROTULOS.semArquivo)
  })

  it('um `EXATO` sem arquivo cai na mesma limitação, em vez de escrever vazio', () => {
    expect(contextoParaOCompositor(elemento, { mapa: 'EXATO' }, ROTULOS)).toContain(ROTULOS.semArquivo)
  })

  it('um elemento sem texto não produz aspas vazias', () => {
    expect(contextoParaOCompositor({ ...elemento, texto: '' }, { mapa: 'AUSENTE' }, ROTULOS)).toContain('<button>\n')
  })
})
