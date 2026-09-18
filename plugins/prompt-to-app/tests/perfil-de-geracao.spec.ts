import { describe, expect, it } from 'vitest'
import { assertGeneratedSource, generationRules } from '../src/import-policy.js'
import {
  PERFIL_EXIGIDO_POR_CATEGORIA, autorizacaoDoAmbiente, perfilEfetivo,
} from '../src/perfil-de-geracao.js'
import { studioProjectCategorySchema } from '../src/model.js'

/*
  O PERFIL DE GERAÇÃO: o que muda entre declarativo e interativo, e o que não.

  Até 18/09/2026 havia um perfil só. Um jogo da velha que o modelo descrevesse
  corretamente era recusado na hora de escrever o código: `useState` é chamada
  de função, `onClick` é atributo de evento, e `casas[indice]` é acesso por
  índice calculado — os três proibidos.

  Este arquivo prova as duas metades da mudança. A metade fácil é o jogo passar.
  A difícil, e a que importa, é TUDO O MAIS continuar recusado no perfil novo.
*/

/** Um tabuleiro de verdade: estado, função própria, evento e índice calculado. */
const JOGO = `import { useState } from 'react'

export function Tabuleiro() {
  const [casas, setCasas] = useState<string[]>(Array(9).fill(''))
  const [vez, setVez] = useState('X')
  function jogar(indice: number) {
    if (casas[indice] !== '') return
    const proximo = [...casas]
    proximo[indice] = vez
    setCasas(proximo)
    setVez(vez === 'X' ? 'O' : 'X')
  }
  return <div>{casas.map((valor, indice) => <button key={indice} onClick={() => jogar(indice)}>{valor}</button>)}</div>
}
`

/** Uma tela declarativa, do jeito que as sete categorias antigas produzem. */
const DECLARATIVA = `export function Inicio() {
  return <section><h1>Padaria da Esquina</h1><p>Pães todo dia.</p></section>
}
`

const arquivo = (content: string) => [{ path: 'src/X.tsx', content }]

describe('o que cada perfil aceita', () => {
  it('o jogo é RECUSADO no declarativo — este era o defeito', () => {
    expect(() => assertGeneratedSource(arquivo(JOGO), 'declarativo')).toThrow()
  })

  it('e ACEITO no interativo', () => {
    expect(() => assertGeneratedSource(arquivo(JOGO), 'interativo')).not.toThrow()
  })

  it('a tela declarativa continua valendo nos DOIS', () => {
    // O perfil novo não pode ser a porta que quebra o que já funcionava.
    expect(() => assertGeneratedSource(arquivo(DECLARATIVA), 'declarativo')).not.toThrow()
    expect(() => assertGeneratedSource(arquivo(DECLARATIVA), 'interativo')).not.toThrow()
  })

  it('o padrão, sem perfil nenhum, é o DECLARATIVO', () => {
    // Um chamador que esqueça o argumento recebe o perfil restrito, e não o
    // permissivo. É a direção certa para um valor padrão de segurança.
    expect(() => assertGeneratedSource(arquivo(JOGO))).toThrow()
  })
})

describe('o que o perfil interativo NÃO libera', () => {
  /*
    Esta é a metade que importa. Liberar o clique não pode liberar o mundo, e
    cada caso aqui é uma família inteira de fuga — não um exemplo escolhido.
  */
  const fugas: readonly (readonly [string, string])[] = [
    ['rede', `export function A() { return <button onClick={() => fetch('https://x.com')}>i</button> }`],
    ['eval', `export function A() { return <button onClick={() => eval('1+1')}>i</button> }`],
    ['Function', `export function A() { return <button onClick={() => Function('return 1')}>i</button> }`],
    ['document', `export function A() { return <button onClick={() => document.title}>i</button> }`],
    ['window', `export function A() { return <button onClick={() => window.open('/')}>i</button> }`],
    ['localStorage', `export function A() { return <button onClick={() => localStorage.clear()}>i</button> }`],
    ['process', `export function A() { return <button onClick={() => process.exit()}>i</button> }`],
    ['constructor', `export function A() { const o = {}; return <button onClick={() => o.constructor}>i</button> }`],
    ['__proto__', `export function A() { const o = {}; return <button onClick={() => o.__proto__}>i</button> }`],
    ['createElement', `import { createElement } from 'react'
export function A() { return <button onClick={() => createElement('script')}>i</button> }`],
    ['script', `export function A() { return <div><script>{'x'}</script></div> }`],
    ['dangerouslySetInnerHTML', `export function A() { return <div dangerouslySetInnerHTML={{ __html: 'x' }} /> }`],
    ['ref', `export function A() { return <button ref={undefined}>i</button> }`],
    ['espalhamento', `export function A() { const p = {}; return <button {...p}>i</button> }`],
    ['modelo com etiqueta', 'export function A() { const f = (s: TemplateStringsArray) => s; return <div>{f`x`}</div> }'],
    ['import dinâmico', `export function A() { return <button onClick={() => import('./outro.js')}>i</button> }`],
    ['use server', `'use server'
export function A() { return <div>x</div> }`],
  ]

  for (const [nome, fonte] of fugas) {
    it(`recusa ${nome} TAMBÉM no interativo`, () => {
      expect(() => assertGeneratedSource(arquivo(fonte), 'interativo')).toThrow()
    })
  }
})

describe('categoria descreve o pedido; ela não concede privilégio', () => {
  it('TODA categoria declara qual perfil ela exige', () => {
    // `Record` exaustivo no tipo; aqui a conferência é em execução, para o caso
    // de o valor vir de fora do compilador — de um registro antigo, por exemplo.
    for (const categoria of studioProjectCategorySchema.options) {
      expect(PERFIL_EXIGIDO_POR_CATEGORIA[categoria], `a categoria ${categoria} não declara perfil`).toBeDefined()
    }
  })

  it('as sete formas conhecidas continuam DECLARATIVAS', () => {
    // Promovê-las junto afrouxaria, de graça, o perfil de tudo o que já funciona.
    for (const categoria of studioProjectCategorySchema.options) {
      if (categoria === 'outro') continue
      expect(PERFIL_EXIGIDO_POR_CATEGORIA[categoria]).toBe('declarativo')
    }
  })

  it('a instalação pode RECUSAR o interativo, e a recusa não vira rebaixamento', () => {
    /*
      Rebaixar para declarativo produziria um jogo sem clique: um aplicativo que
      nasce quebrado e não diz por quê. A recusa nomeia a causa.
    */
    const trancada = autorizacaoDoAmbiente({ DZ23_GERACAO_INTERATIVA: 'nao' })
    const escolha = perfilEfetivo('outro', trancada)
    expect(escolha.tipo).toBe('NAO_AUTORIZADO')
    expect(escolha.tipo === 'NAO_AUTORIZADO' ? escolha.exigido : null).toBe('interativo')
    // E o declarativo continua funcionando na instalação trancada.
    expect(perfilEfetivo('landing-page', trancada)).toEqual({ tipo: 'AUTORIZADO', perfil: 'declarativo' })
  })

  it('a instalação padrão autoriza os dois', () => {
    expect(perfilEfetivo('outro', autorizacaoDoAmbiente({}))).toEqual({ tipo: 'AUTORIZADO', perfil: 'interativo' })
  })

  it('o perfil sai da CATEGORIA e da INSTALAÇÃO — e de mais nada', () => {
    /*
      A garantia anti-escalada é estrutural, e é por isso que ela cabe num teste
      curto: `perfilEfetivo` recebe dois argumentos, e nenhum deles vem do
      modelo. Não existe campo de perfil no que o modelo devolve, então não há
      valor que ele possa mandar para ser lido aqui.
    */
    expect(perfilEfetivo.length).toBe(2)
  })
})

describe('as regras que o modelo recebe saem do perfil que o recusa', () => {
  it('o declarativo PROÍBE o que faz um aplicativo reagir', () => {
    const regras = generationRules('declarativo').join(' ')
    expect(regras).toMatch(/somente JSX declarativo/iu)
    expect(regras).toMatch(/atributos de evento/iu)
    // E não pede comportamento: a regra do esboço só existe no interativo.
    expect(regras).not.toMatch(/critério de aceitação/iu)
  })

  it('o interativo PERMITE estado e evento, e repete o que continua proibido', () => {
    const regras = generationRules('interativo').join(' ')
    expect(regras).toMatch(/useState/u)
    expect(regras).toMatch(/onClick/u)
    // A regra não pode liberar sem lembrar do limite: um prompt que só diz
    // "pode ter comportamento" faz o modelo gastar tentativa com `fetch`.
    expect(regras).toMatch(/\bref\b/u)
    expect(regras).toMatch(/eval/u)
  })

  it('e o interativo EXIGE corpo de função — a regra nasceu de uma recusa medida', () => {
    // O primeiro jogo que um modelo real escreveu aqui tinha nove botões, um
    // `onClick` em cada um, e o corpo das funções vazio com comentário dentro.
    const regras = generationRules('interativo').join(' ')
    expect(regras).toMatch(/corpo/iu)
    expect(regras).toMatch(/critério de aceitação/iu)
  })

  it('as duas listas continuam vindo da MESMA fonte que recusa', () => {
    // `fetch` está em `FORBIDDEN_NETWORK_APIS`, e a regra o cita porque LÊ a
    // lista — e não porque alguém escreveu "sem rede" à mão no catálogo.
    for (const perfil of ['declarativo', 'interativo'] as const) {
      expect(generationRules(perfil).join(' ')).toContain('fetch')
    }
  })
})
