import { describe, expect, it } from 'vitest'
import { MARKDOWN_MAX_CHARS, inlineText, parseInline, parseMarkdown } from './markdown'

describe('blocos', () => {
  it('parágrafo junta as linhas, e a linha em branco separa', () => {
    expect(parseMarkdown('uma\nfrase\n\noutra')).toEqual([
      { kind: 'paragraph', children: [{ kind: 'text', text: 'uma frase' }] },
      { kind: 'paragraph', children: [{ kind: 'text', text: 'outra' }] },
    ])
  })

  it('a cerca de código é resolvida ANTES de qualquer marcação', () => {
    // Este é o erro que embaralhava o programa: `**` dentro de um exemplo
    // viraria negrito, e `#` viraria título.
    const blocks = parseMarkdown('```ts\nconst a = "**x**"\n# não é título\n```')
    expect(blocks).toEqual([{ kind: 'code', language: 'ts', text: 'const a = "**x**"\n# não é título' }])
  })

  it('cerca aberta e não fechada continua sendo código até o fim', () => {
    // Tratar o resto como parágrafo entregaria o programa deformado.
    expect(parseMarkdown('```\nlinha 1\nlinha 2')).toEqual([
      { kind: 'code', language: null, text: 'linha 1\nlinha 2' },
    ])
  })

  it('uma cerca não fecha a outra quando o caractere é diferente', () => {
    const blocks = parseMarkdown('~~~\nexemplo com ``` dentro\n~~~\ndepois')
    expect(blocks[0]).toEqual({ kind: 'code', language: null, text: 'exemplo com ``` dentro' })
    expect(blocks[1]).toEqual({ kind: 'paragraph', children: [{ kind: 'text', text: 'depois' }] })
  })

  it('o nome da linguagem é estreito: ele vira classe no HTML', () => {
    expect(parseMarkdown('```js\nx\n```')[0]).toMatchObject({ language: 'js' })
    // Texto arbitrário do modelo dentro de um atributo de classe é superfície
    // que não precisa existir.
    for (const bad of ['"><script>', 'muito-longo'.repeat(9), 'com espaço']) {
      // O bloco continua sendo CÓDIGO: recusar a linha inteira por causa do
      // nome faria o exemplo virar parágrafo e sair deformado.
      expect(parseMarkdown(`\`\`\`${bad}\nx\n\`\`\``)[0], bad).toEqual({ kind: 'code', language: null, text: 'x' })
    }
  })

  it('títulos vão até o nível 3, e o resto é parágrafo', () => {
    expect(parseMarkdown('# um')[0]).toMatchObject({ kind: 'heading', level: 1 })
    expect(parseMarkdown('### três')[0]).toMatchObject({ kind: 'heading', level: 3 })
    expect(parseMarkdown('#### quatro')[0]).toMatchObject({ kind: 'paragraph' })
    expect(parseMarkdown('#sem espaço')[0]).toMatchObject({ kind: 'paragraph' })
  })

  it('listas com marcador e listas numeradas', () => {
    expect(parseMarkdown('- um\n- dois')).toEqual([
      { kind: 'list', ordered: false, items: [[{ kind: 'text', text: 'um' }], [{ kind: 'text', text: 'dois' }]] },
    ])
    expect(parseMarkdown('1. um\n2) dois')[0]).toMatchObject({ kind: 'list', ordered: true })
  })

  it('citação junta as linhas dela', () => {
    expect(parseMarkdown('> uma\n> outra')).toEqual([
      { kind: 'quote', children: [{ kind: 'text', text: 'uma outra' }] },
    ])
  })

  it('linha horizontal, e um traço solto que NÃO é linha', () => {
    expect(parseMarkdown('---')).toEqual([{ kind: 'rule' }])
    expect(parseMarkdown('- item')[0]).toMatchObject({ kind: 'list' })
  })

  it('texto grande demais não é interpretado, e não trava a aba', () => {
    const huge = `**a**${'x'.repeat(MARKDOWN_MAX_CHARS)}`
    expect(parseMarkdown(huge)).toEqual([{ kind: 'paragraph', children: [{ kind: 'text', text: huge }] }])
  })

  it('texto vazio não vira bloco nenhum', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('\n\n  \n')).toEqual([])
  })

  it('CRLF é lido igual a LF', () => {
    expect(parseMarkdown('a\r\n\r\nb')).toHaveLength(2)
  })
})

describe('marcação dentro da linha', () => {
  it('negrito, itálico e código', () => {
    expect(parseInline('**forte** e *leve* e `código`')).toEqual([
      { kind: 'strong', children: [{ kind: 'text', text: 'forte' }] },
      { kind: 'text', text: ' e ' },
      { kind: 'em', children: [{ kind: 'text', text: 'leve' }] },
      { kind: 'text', text: ' e ' },
      { kind: 'code', text: 'código' },
    ])
  })

  it('o conteúdo entre crases NUNCA é reinterpretado', () => {
    expect(parseInline('`**não é negrito**`')).toEqual([{ kind: 'code', text: '**não é negrito**' }])
  })

  it('crases duplas permitem uma crase dentro', () => {
    expect(parseInline('``a ` b``')).toEqual([{ kind: 'code', text: 'a ` b' }])
  })

  it('só http e https viram link; o resto vira o texto que o modelo escreveu', () => {
    expect(parseInline('[site](https://exemplo.invalid/a)')).toEqual([
      { kind: 'link', href: 'https://exemplo.invalid/a', children: [{ kind: 'text', text: 'site' }] },
    ])
    // Um link que EXECUTA não é um link: é o modelo apertando um botão na
    // página de quem está lendo.
    for (const perigoso of [
      '[x](javascript:alert(1))', '[x](data:text/html,<script>)', '[x](vbscript:x)',
      '[x](file:///etc/passwd)', '[x](//exemplo.invalid)', '[x](JavaScript:alert(1))',
    ]) {
      const nodes = parseInline(perigoso)
      // As duas coisas que importam: nenhum link nasce, e o que a pessoa lê é
      // exatamente o que o modelo escreveu - nada some da tela.
      expect(nodes.some(node => node.kind === 'link'), perigoso).toBe(false)
      expect(inlineText(nodes), perigoso).toBe(perigoso)
    }
  })

  it('imagem vira LINK, e nunca uma imagem remota', () => {
    // Uma imagem remota numa resposta avisa a um terceiro que a pessoa leu a
    // mensagem, e este produto diz que nada sai do computador dela.
    expect(parseInline('![gato](https://exemplo.invalid/g.png)')).toEqual([
      { kind: 'link', href: 'https://exemplo.invalid/g.png', children: [{ kind: 'text', text: 'gato' }] },
    ])
    expect(parseInline('![](https://exemplo.invalid/g.png)')).toEqual([
      { kind: 'link', href: 'https://exemplo.invalid/g.png', children: [{ kind: 'text', text: 'https://exemplo.invalid/g.png' }] },
    ])
    const perigosa = parseInline('![x](javascript:alert(1))')
    expect(perigosa.some(node => node.kind === 'link')).toBe(false)
    expect(inlineText(perigosa)).toBe('![x](javascript:alert(1))')
  })

  it('marcação que este leitor não conhece vira TEXTO, nunca marcação', () => {
    for (const bruto of [
      '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<b>negrito</b>',
      '<a href="javascript:x">y</a>', '&lt;b&gt;',
    ]) {
      expect(inlineText(parseInline(bruto)), bruto).toBe(bruto)
      expect(parseInline(bruto).every(node => node.kind === 'text'), bruto).toBe(true)
    }
  })

  it('asterisco solto continua sendo asterisco', () => {
    expect(parseInline('2 * 3 * 4')).toEqual([{ kind: 'text', text: '2 * 3 * 4' }])
    expect(parseInline('a ** b')).toEqual([{ kind: 'text', text: 'a ** b' }])
  })

  it('negrito dentro de link, e link dentro de negrito', () => {
    expect(parseInline('[**a**](https://e.invalid/)')).toEqual([
      { kind: 'link', href: 'https://e.invalid/', children: [{ kind: 'strong', children: [{ kind: 'text', text: 'a' }] }] },
    ])
    expect(parseInline('**[a](https://e.invalid/)**')).toEqual([
      { kind: 'strong', children: [{ kind: 'link', href: 'https://e.invalid/', children: [{ kind: 'text', text: 'a' }] }] },
    ])
  })

  it('o texto puro devolve o que a pessoa leria', () => {
    expect(inlineText(parseInline('**a** `b` [c](https://e.invalid/)'))).toBe('a b c')
  })
})
