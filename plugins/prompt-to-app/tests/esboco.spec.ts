import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { EsbocoEncontradoError, assertSemEsboco, funcoesVazias } from '../src/esboco.js'
import { assertGeneratedSource } from '../src/import-policy.js'

/*
  O ESBOÇO: comportamento prometido na tela e não escrito no código.

  A fonte abaixo é LITERAL: o `qwen2.5-coder:7b` da máquina do titular a
  produziu em 18/09/2026, com saída estruturada, para o pedido do jogo da velha.
  Ela atravessou o decodificador, o schema e a política de imports inteira — e
  o jogo não joga, porque as duas funções que fariam alguma coisa têm o corpo
  vazio com um comentário dentro.
*/
const JOGO_DO_MODELO_REAL = `import React, { useState } from 'react';

const GeneratedApp: React.FC = () => {
  const [partida, setPartida] = useState({ casas: '_________', vez: 'X', vencedor: null });

  const handleClick = (index: number) => {
    // Lógica para lidar com o clique na casa
  };

  return (
    <div>
      <h1>Jogo da Velha</h1>
      {Array.from({ length: 9 }, (_, i) => (
        <button key={i} onClick={() => handleClick(i)}>{partida.casas[i]}</button>
      ))}
    </div>
  );
};

export default GeneratedApp;
`

/** O mesmo jogo, com o corpo escrito. */
const JOGO_COM_COMPORTAMENTO = `import { useState } from 'react'

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

const analisar = (fonte: string) => ts.createSourceFile('src/X.tsx', fonte, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const arquivo = (content: string) => [{ path: 'src/X.tsx', content }]

describe('a promessa vazia, medida contra a saída real do modelo', () => {
  it('o jogo que o modelo REAL escreveu é recusado — ele não joga', () => {
    /*
      Este é o achado. Todas as outras guardas perguntam "o que este código pode
      fazer de errado?", e um corpo vazio não pode fazer nada — que é o problema.
      Sem esta guarda, o aplicativo chegaria ao disco, abriria, desenharia o
      tabuleiro e responderia ao clique com silêncio.
    */
    expect(() => assertGeneratedSource(arquivo(JOGO_DO_MODELO_REAL), 'interativo')).toThrow(EsbocoEncontradoError)
  })

  it('e a mensagem diz QUAL função e em que linha', () => {
    // "Recusado" sem o nome manda a pessoa reler o arquivo inteiro.
    try {
      assertSemEsboco('src/X.tsx', analisar(JOGO_DO_MODELO_REAL))
      expect.unreachable('deveria ter recusado')
    } catch (erro) {
      expect((erro as Error).message).toContain('handleClick')
      expect((erro as Error).message).toMatch(/linha \d+/u)
    }
  })

  it('o mesmo jogo COM comportamento passa', () => {
    expect(() => assertGeneratedSource(arquivo(JOGO_COM_COMPORTAMENTO), 'interativo')).not.toThrow()
  })
})

describe('o que conta como vazio, e o que não conta', () => {
  it('corpo com SÓ comentário é vazio — comentário não roda', () => {
    expect(funcoesVazias(analisar('function f() { /* faz o cálculo */ }')).length).toBe(1)
    expect(funcoesVazias(analisar('function f() {}')).length).toBe(1)
  })

  it('uma instrução só já é corpo, mesmo que devolva nada', () => {
    // Devolver nada é uma decisão. Não ter corpo é a ausência de uma.
    expect(funcoesVazias(analisar('function f() { return }')).length).toBe(0)
    expect(funcoesVazias(analisar('const f = () => 1')).length).toBe(0)
  })

  it('`() => {}` cru como ARGUMENTO é tratador neutro, e passa', () => {
    expect(funcoesVazias(analisar('const x = fazer(() => {})')).length).toBe(0)
  })

  it('mas o mesmo argumento COM comentário dentro volta a ser promessa', () => {
    expect(funcoesVazias(analisar('const x = fazer(() => { /* depois eu escrevo */ })')).length).toBe(1)
  })

  it('pega método de classe e função anônima também', () => {
    expect(funcoesVazias(analisar('class A { jogar() {} }')).map(f => f.nome)).toEqual(['jogar'])
    expect(funcoesVazias(analisar('const o = { jogar: function () {} }')).map(f => f.nome)).toEqual(['jogar'])
  })

  it('assinatura sem corpo NÃO é esboço — é declaração de tipo', () => {
    // `declare function` e sobrecarga não têm corpo por definição; recusá-las
    // seria recusar a linguagem.
    expect(funcoesVazias(analisar('declare function f(): void')).length).toBe(0)
  })
})

describe('a guarda vale só onde a promessa existe', () => {
  it('no perfil DECLARATIVO ela não roda', () => {
    /*
      Uma tela declarativa não tem corpo de função para preencher: ela é JSX
      parado, e é assim que ela deve ser. Rodar a guarda lá recusaria o que já
      funciona hoje.
    */
    const declarativa = 'export function Inicio() { return <section><h1>Padaria</h1></section> }'
    expect(() => assertGeneratedSource(arquivo(declarativa), 'declarativo')).not.toThrow()
    expect(() => assertGeneratedSource(arquivo(JOGO_DO_MODELO_REAL), 'declarativo')).toThrow()
  })
})
