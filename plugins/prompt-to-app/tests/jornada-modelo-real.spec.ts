import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeModelJson } from '../src/model-json.js'
import { generatedOutputSchema } from '../src/pipeline.js'
import { assertGeneratedSource } from '../src/import-policy.js'

/*
  A JORNADA CONTRA MODELO REAL, guardada arquivo por arquivo.

  Estas DUAS respostas são literais. Saíram do `qwen2.5-coder:7b` rodando no
  Ollama da máquina do titular em 18/09/2026, pelo prompt que o PRÓPRIO produto
  monta — mesmas regras, mesmo AppSpec, mesmo plano, com saída estruturada.

  `jogo-v2.json` é a PRIMEIRA tentativa. Ela traz um jogo da velha completo, e é
  recusada por um único atributo `style`.

  `jogo-v7.json` é a rodada de REPARO, depois de três consertos que esta sessão
  mediu um a um: o reparo passou a levar o ARTEFATO anterior, a recusa passou a
  dizer ONDE, e passou a dizer o QUE USAR no lugar. Ela atravessa o caminho
  inteiro.

  Entre as duas houve três reparos que FALHARAM, e o que eles mediram está
  escrito abaixo, porque é a parte que não se vê no arquivo que deu certo.
*/

const aqui = dirname(fileURLToPath(import.meta.url))
const resposta = (nome: string) => readFileSync(join(aqui, 'modelo-real', nome), 'utf8')

const arquivosDe = (nome: string) => generatedOutputSchema.parse(decodeModelJson(resposta(nome))).files
const codigoDe = (nome: string) => arquivosDe(nome).find(arquivo => arquivo.path.endsWith('.tsx'))?.content ?? ''

describe('a primeira tentativa: jogo completo, recusado por um atributo', () => {
  it('a saída ESTRUTURADA é JSON válido — sem ela, a mesma família de resposta era ilegível', () => {
    expect(() => decodeModelJson(resposta('jogo-v2.json'))).not.toThrow()
  })

  it('e bate com o contrato de saída do produto', () => {
    expect(arquivosDe('jogo-v2.json').map(arquivo => arquivo.path).sort())
      .toEqual(['content/app.json', 'src/GeneratedApp.tsx'])
  })

  it('a política a RECUSA, e diz onde e o que usar no lugar', () => {
    try {
      assertGeneratedSource(arquivosDe('jogo-v2.json'), 'interativo')
      expect.unreachable('deveria ter recusado')
    } catch (erro) {
      const mensagem = (erro as Error).message
      expect(mensagem).toContain('style')
      expect(mensagem).toMatch(/linha \d+/u)
      expect(mensagem).toContain('className')
    }
  })
})

describe('a rodada de reparo: o mesmo jogo, aceito', () => {
  it('ATRAVESSA o caminho inteiro — decodificador, contrato e política', () => {
    // Primeira vez nesta missão que um modelo real escreveu um aplicativo que
    // passa em tudo. Antes disto, todo o caminho era provado contra dublê.
    const arquivos = arquivosDe('jogo-v7.json')
    expect(() => assertGeneratedSource(arquivos, 'interativo')).not.toThrow()
  })

  it('o `style` saiu e o `className` entrou', () => {
    expect(codigoDe('jogo-v7.json')).not.toContain('style=')
    expect(codigoDe('jogo-v7.json')).toContain('className')
  })

  it('e o COMPORTAMENTO sobreviveu ao reparo — que é o ponto', () => {
    /*
      O reparo sem o artefato anterior consertava a causa e destruía o resto:
      medido, o jogo voltou como esqueleto com o corpo da jogada vazio. Aqui as
      cinco regras do pedido continuam escritas.
    */
    const codigo = codigoDe('jogo-v7.json')
    expect(codigo).toMatch(/useState/u)                          // estado do tabuleiro
    expect(codigo).toMatch(/if \(casas\[index\] \|\| vencedor\)/u) // casa ocupada não muda nada
    expect(codigo).toMatch(/vez === 'X' \? 'O' : 'X'/u)           // alternância
    expect(codigo).toMatch(/\[0, 4, 8\]/u)                        // as diagonais, entre as oito linhas
    expect(codigo).toMatch(/Empate/u)                             // tabuleiro cheio sem três iguais
    expect(codigo).toMatch(/Reiniciar/u)                          // o botão que limpa
  })

  it('o aplicativo NÃO é um esboço: nenhuma função tem corpo vazio', () => {
    expect(() => assertGeneratedSource(arquivosDe('jogo-v7.json'), 'interativo')).not.toThrow()
  })
})

describe('o que ficou POR RESOLVER, escrito aqui para não sumir', () => {
  it('o `content/app.json` voltou VAZIO, e nada no caminho recusa isso', () => {
    /*
      LIMITE MEDIDO, e ele é real. O modelo devolveu `{}` para um arquivo
      previsto no plano que deveria trazer a especificação. Nenhuma guarda
      reclama: a política de código só olha arquivo de código, e o esboço só
      olha corpo de função.

      É a mesma família do esboço — arquivo que promete conteúdo e não tem —, e
      merece a mesma resposta: uma guarda que o recuse. Ela NÃO foi escrita
      nesta fatia, e este caso existe para que a ausência dela seja visível em
      vez de esquecida. Quando a guarda existir, este caso inverte.
    */
    const conteudo = arquivosDe('jogo-v7.json').find(arquivo => arquivo.path === 'content/app.json')?.content ?? ''
    expect(JSON.parse(conteudo)).toEqual({})
    expect(() => assertGeneratedSource(arquivosDe('jogo-v7.json'), 'interativo')).not.toThrow()
  })
})
