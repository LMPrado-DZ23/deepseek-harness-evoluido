import { describe, expect, it } from 'vitest'
import {
  FonteGrandeDemais, FonteNaoServida, LIMITE_DA_FONTE,
  caminhoDeclarado, conteudoQueCabe, fonteAServir, formaNormalizada,
} from '../src/fonte-do-artefato.js'

/*
  A LISTA BRANCA vem do relato, e não do disco.

  O jeito comum — normalizar o caminho e conferir que ele continua debaixo da
  raiz — funciona e é frágil: cada forma nova de escrever o mesmo caminho é uma
  chance nova de a conferência discordar do sistema de arquivos, e quem ganha a
  discordância é o sistema de arquivos.

  Aqui a pergunta é se o caminho ESTÁ na lista que o produto gravou. Nenhum `..`
  inventa uma entrada numa lista.
*/

const RELATO = {
  files: [
    { path: 'src/GeneratedApp.tsx', lines: 40, bytes: 1200 },
    { path: 'content/app.json', lines: 1, bytes: 800 },
  ],
}

describe('só o que o relato declara é servido', () => {
  it('um arquivo declarado é servido', () => {
    expect(fonteAServir(RELATO, 'src/GeneratedApp.tsx')).toBe('src/GeneratedApp.tsx')
    expect(fonteAServir(RELATO, 'content/app.json')).toBe('content/app.json')
  })

  const fugas: readonly (readonly [string, string])[] = [
    ['travessia simples', '../../../etc/passwd'],
    ['travessia a partir de um declarado', 'src/../../etc/passwd'],
    ['barra invertida', '..\\..\\etc\\passwd'],
    ['caminho absoluto', '/etc/passwd'],
    ['arquivo do mecanismo, não declarado', 'run-report.json'],
    ['arquivo do template, não declarado', 'package.json'],
    ['vazio', ''],
    ['só barras', '///'],
    ['ponto', '.'],
  ]

  for (const [nome, caminho] of fugas) {
    it(`recusa ${nome}`, () => {
      expect(() => fonteAServir(RELATO, caminho)).toThrow(FonteNaoServida)
    })
  }

  it('um caminho DECLARADO escrito de outro jeito ainda casa', () => {
    // `./src/...` e `src/...` são o mesmo arquivo, e recusar um deles seria
    // recusar o que o produto escreveu.
    expect(fonteAServir(RELATO, './src/GeneratedApp.tsx')).toBe('src/GeneratedApp.tsx')
    expect(fonteAServir(RELATO, 'src\\GeneratedApp.tsx')).toBe('src/GeneratedApp.tsx')
  })

  it('e o resultado é sempre o caminho DECLARADO, não o pedido', () => {
    /*
      Quem lê o disco usa o que sai daqui. Devolver o texto que a pessoa mandou
      devolveria a conferência para o sistema de arquivos — que é exatamente o
      que esta lista existe para evitar.
    */
    expect(fonteAServir(RELATO, 'src\\GeneratedApp.tsx')).not.toContain('\\')
  })

  it('relato ausente ou quebrado não serve nada', () => {
    // Ausência de relato é ausência de lista; sem lista, não há o que permitir.
    for (const relato of [null, undefined, {}, { files: 'nao e lista' }, 42]) {
      expect(() => fonteAServir(relato, 'src/GeneratedApp.tsx')).toThrow(FonteNaoServida)
    }
  })
})

describe('a segunda linha: nem o RELATO pode declarar uma travessia', () => {
  it('um relato que lista `..` não serve esse caminho', () => {
    /*
      A lista branca sozinha confia no relato, e o relato é um arquivo em disco.
      Se ele for adulterado — ou se um dia alguém gravar ali um caminho que
      `validateGeneratedPath` deveria ter recusado —, a lista passaria a
      autorizar a fuga que ela existe para impedir.

      Esta conferência é defesa em profundidade, e sem este caso ela era código
      morto: a sabotagem que a removeu SOBREVIVEU, porque nenhum relato honesto
      tem `..` no nome de arquivo.
    */
    const adulterado = { files: [{ path: '../../../etc/passwd' }, { path: 'src/A.tsx' }] }
    expect(() => fonteAServir(adulterado, '../../../etc/passwd')).toThrow(FonteNaoServida)
    // E o arquivo honesto do mesmo relato continua servido.
    expect(fonteAServir(adulterado, 'src/A.tsx')).toBe('src/A.tsx')
  })

  it('e um segmento vazio no meio também não', () => {
    expect(caminhoDeclarado(['src//A.tsx'], 'src//A.tsx')).toBeNull()
  })
})

describe('a forma normalizada é a mesma dos dois lados', () => {
  it('barra invertida, `./` e barra inicial somem', () => {
    expect(formaNormalizada('src\\A.tsx')).toBe('src/A.tsx')
    expect(formaNormalizada('./src/A.tsx')).toBe('src/A.tsx')
    expect(formaNormalizada('/src/A.tsx')).toBe('src/A.tsx')
  })

  it('mas `..` NÃO é resolvido — ele é recusado depois', () => {
    /*
      Resolver `..` transformaria um caminho de fuga em outro caminho, e a
      conferência passaria a depender de resolver igual ao sistema de arquivos.
      Nenhum arquivo que o produto escreve tem `..` no nome, então recusar é a
      resposta certa e a mais simples de conferir.
    */
    expect(formaNormalizada('src/../etc')).toBe('src/../etc')
    expect(caminhoDeclarado(['src/A.tsx'], 'src/../src/A.tsx')).toBeNull()
  })
})

describe('o tamanho é recusado, e não cortado', () => {
  it('um arquivo que cabe atravessa inteiro', () => {
    const conteudo = 'export const A = 1\n'
    expect(conteudoQueCabe(conteudo)).toBe(conteudo)
  })

  it('um arquivo grande demais é RECUSADO', () => {
    /*
      Cortar seria pior: um arquivo pela metade parece um arquivo, e a pessoa
      leria código que não é o que está lá.
    */
    expect(() => conteudoQueCabe('x'.repeat(LIMITE_DA_FONTE + 1))).toThrow(FonteGrandeDemais)
  })

  it('o limite é medido em BYTES, e não em caracteres', () => {
    // Um arquivo de acentos tem mais bytes que caracteres; medir caracteres
    // deixaria passar quase o dobro.
    const acentuado = 'é'.repeat(Math.ceil(LIMITE_DA_FONTE / 2) + 1)
    expect(acentuado.length).toBeLessThanOrEqual(LIMITE_DA_FONTE)
    expect(() => conteudoQueCabe(acentuado)).toThrow(FonteGrandeDemais)
  })

  it('a recusa por tamanho é distinguível da recusa por lista', () => {
    // Causas diferentes pedem consertos diferentes: uma é "este arquivo não é
    // seu"; a outra é "este arquivo é seu e não cabe".
    expect(new FonteGrandeDemais('x').code).toBe('FONTE_GRANDE_DEMAIS')
    expect(new FonteNaoServida('x').code).toBe('FONTE_FORA_DA_LISTA')
    // E quem trata a primeira continua tratando a segunda, porque ela estende.
    expect(new FonteGrandeDemais('x')).toBeInstanceOf(FonteNaoServida)
  })
})
