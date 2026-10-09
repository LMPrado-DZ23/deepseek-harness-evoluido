import { describe, expect, it } from 'vitest'
import { LIMITE_DO_TEXTO, TAG_DO_ROTEIRO, comRoteiroDeSelecao, scriptDeSelecao } from '../src/selecao.js'

const ORIGEM = 'http://studio.dz23.localhost:7710'

describe('o roteiro só obedece a quem tem as DUAS credenciais', () => {
  const roteiro = scriptDeSelecao(ORIGEM)

  it('confere a ORIGEM e a JANELA, e não uma das duas', () => {
    /*
      A origem sozinha aceitaria qualquer aba daquele host; a janela sozinha
      aceitaria qualquer origem que conseguisse embutir a prévia. As duas
      juntas são o que restringe o comando ao FRIGG que abriu este quadro.
    */
    expect(roteiro).toContain(`evento.origin!==${JSON.stringify(ORIGEM)}`)
    expect(roteiro).toContain('evento.source!==window.parent')
  })

  it('a origem entra CODIFICADA, e não concatenada', () => {
    // Uma aspa dentro da origem fecharia a cadeia e viraria código.
    const comAspas = scriptDeSelecao('http://x"+alert(1)+"')
    expect(comAspas).toContain(JSON.stringify('http://x"+alert(1)+"'))
    expect(comAspas).not.toContain('+alert(1)+"')
  })

  it('só o modo de seleção liga a seleção', () => {
    expect(roteiro).toContain('DZ23_PREVIEW_SELECT_MODE')
    expect(roteiro).toContain('corpo.on===true')
  })

  it('a resposta vai para a origem do FRIGG, e nunca para `*`', () => {
    expect(roteiro).toContain(`},${JSON.stringify(ORIGEM)})`)
    expect(roteiro).not.toContain('"*"')
  })
})

describe('o que o roteiro lê, e o que ele não toca', () => {
  const roteiro = scriptDeSelecao(ORIGEM)

  it('relata etiqueta, texto e rota — e nada mais', () => {
    for (const campo of ['tag:', 'text:', 'path:']) expect(roteiro).toContain(campo)
  })

  it('o texto é CORTADO no limite declarado', () => {
    expect(roteiro).toContain(`.slice(0,${String(LIMITE_DO_TEXTO)})`)
  })

  it('não faz requisição, não lê armazenamento e não avalia texto', () => {
    // O roteiro roda dentro do aplicativo da pessoa. O que ele pode fazer é o
    // que ele faz: olhar o que foi clicado.
    for (const proibido of ['fetch(', 'XMLHttpRequest', 'localStorage', 'sessionStorage', 'document.cookie', 'eval(', 'Function(']) {
      expect(roteiro, proibido).not.toContain(proibido)
    }
  })

  it('com a seleção ligada, o clique é DA SELEÇÃO e não do aplicativo', () => {
    /*
      Sem isto, escolher o botão "Reiniciar" reiniciaria o jogo enquanto a
      pessoa só queria apontá-lo — e ela veria o aplicativo fazer uma coisa que
      não pediu.
    */
    expect(roteiro).toContain('evento.preventDefault()')
    expect(roteiro).toContain('evento.stopPropagation()')
    expect(roteiro).toContain('"click",escolher,true')
  })

  it('o realce é desfeito, e nada é acrescentado ao documento', () => {
    // Nada de `createElement` nem `appendChild`: o contorno vai no próprio
    // elemento e sai dele, então nada sobra no aplicativo.
    expect(roteiro).toContain('outline=""')
    for (const proibido of ['createElement', 'appendChild', 'innerHTML']) {
      expect(roteiro, proibido).not.toContain(proibido)
    }
  })
})

describe('a etiqueta entra SÓ onde ela pode entrar', () => {
  const pagina = (corpo: string) => Buffer.from(`<!doctype html><html><body>${corpo}</body></html>`, 'utf8')

  it('numa página HTML, ela entra antes do fim do corpo', () => {
    const saida = comRoteiroDeSelecao(pagina('<h1>Jogo</h1>'), 'text/html; charset=utf-8').toString('utf8')
    expect(saida).toContain(TAG_DO_ROTEIRO)
    expect(saida.indexOf(TAG_DO_ROTEIRO)).toBeLessThan(saida.lastIndexOf('</body>'))
  })

  it('o que NÃO é HTML volta byte por byte', () => {
    /*
      Reescrever bytes de uma resposta que não pediu para ser reescrita quebra
      o aplicativo de um jeito que ninguém depura: o código-fonte está certo e
      o navegador mostra outra coisa.
    */
    for (const tipo of ['application/json', 'text/javascript', 'image/png', 'text/plain', undefined]) {
      const corpo = pagina('<h1>x</h1>')
      expect(comRoteiroDeSelecao(corpo, tipo).equals(corpo), String(tipo)).toBe(true)
    }
  })

  it('HTML sem `</body>` volta intacto', () => {
    const fragmento = Buffer.from('<div>pedaço de página</div>', 'utf8')
    expect(comRoteiroDeSelecao(fragmento, 'text/html').equals(fragmento)).toBe(true)
  })

  it('a etiqueta não entra DUAS vezes', () => {
    const uma = comRoteiroDeSelecao(pagina('<h1>x</h1>'), 'text/html')
    const duas = comRoteiroDeSelecao(uma, 'text/html')
    expect(duas.toString('utf8').split(TAG_DO_ROTEIRO).length - 1).toBe(1)
  })

  it('o `</body>` que fecha é o ÚLTIMO, e não um que apareça no texto', () => {
    // Um documento pode trazer `</body>` dentro de um exemplo de código.
    const comExemplo = Buffer.from('<html><body><pre>&lt;/body&gt;</pre></body></html>', 'utf8')
    const saida = comRoteiroDeSelecao(Buffer.from(comExemplo.toString('utf8').replace('&lt;/body&gt;', '</body>'), 'utf8'), 'text/html').toString('utf8')
    expect(saida.lastIndexOf(TAG_DO_ROTEIRO)).toBeGreaterThan(saida.indexOf('<pre>'))
  })

  it('o acento sobrevive à reescrita', () => {
    // A leitura e a volta passam por UTF-8 nos dois sentidos; errar isso
    // transforma "pedaço" em "pedaÃ§o" na tela da pessoa.
    const saida = comRoteiroDeSelecao(pagina('<h1>Ação</h1>'), 'text/html').toString('utf8')
    expect(saida).toContain('Ação')
  })
})
