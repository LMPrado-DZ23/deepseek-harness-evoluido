import { describe, expect, it } from 'vitest'
import {
  SaidaEstruturadaIndisponivel, TETO_DE_SAIDA,
  consumirMarca, corpoEstruturado, esquemaJsonDaSaida, leituraDaResposta,
  desvioEstruturado, enderecoNativo, gerarEstruturado,
  marcarEstruturada, pedacosDaResposta, textoDeUmaMensagem,
} from '../src/saida-estruturada.js'
import { generatedFileSchema } from '../src/generator.js'
import { decodeModelJson } from '../src/model-json.js'
import { generatedOutputSchema } from '../src/pipeline.js'
import { assertGeneratedSource } from '../src/import-policy.js'

/*
  A SAÍDA ESTRUTURADA, medida contra o Ollama do titular em 18/09/2026.

  As duas respostas abaixo são LITERAIS. Mesmo prompt de geração, mesmo modelo,
  mesma temperatura — a única diferença é o campo `format` carregando o schema.
  Foi assim que a diferença virou medição em vez de opinião.
*/

/** Resposta SEM `format`: cercada em markdown e com quebra de linha CRUA na string. */
const LIVRE = '```json\n{\n  "files": [\n    {\n      "path": "src/GeneratedApp.tsx",\n'
  + '      "content": "export function App() {\nreturn <div>oi</div>\n}"\n    }\n  ]\n}\n```'

/** Resposta COM `format`: JSON válido, fechado pelo servidor. */
const ESTRUTURADA = '{"files":[{"path":"src/GeneratedApp.tsx","content":"import { useState } from \'react\'\\n'
  + 'export function App() { return <div /> }\\n"}]}'

describe('a diferença que o `format` fez, medida', () => {
  it('SEM o schema a resposta real é ILEGÍVEL — e o decodificador recusa', () => {
    /*
      Esta é a falha que atravessou a missão. O JSON está quase certo: a string
      `content` tem quebras de linha cruas, que JSON não permite. Nenhuma
      tolerância de invólucro salva isso, e nem deveria salvar — consertar a
      string seria inventar conteúdo.
    */
    expect(() => decodeModelJson(LIVRE)).toThrow()
  })

  it('COM o schema a mesma resposta é lida, aprovada e segue para a política', () => {
    const decodificado = decodeModelJson(ESTRUTURADA)
    const saida = generatedOutputSchema.parse(decodificado)
    expect(saida.files.map(arquivo => arquivo.path)).toEqual(['src/GeneratedApp.tsx'])
    // E a validação SEMÂNTICA continua no caminho: a gramática garante a forma,
    // e nada mais. Este arquivo passa; o da medição real foi RECUSADO por
    // importar um módulo inventado, que é exatamente o que tinha de acontecer.
    expect(() => assertGeneratedSource(saida.files, 'interativo')).not.toThrow()
  })
})

describe('o schema que desce é o MESMO que confere na volta', () => {
  it('o JSON Schema sai do Zod, e não da minha mão', () => {
    const esquema = esquemaJsonDaSaida()
    expect(esquema).toMatchObject({ type: 'object', required: ['files'] })
    const arquivos = (esquema as { properties: { files: { items: { required: string[] } } } }).properties.files.items
    /*
      A conferência é contra o schema DE VERDADE, e não contra uma lista que eu
      escrevi aqui: um campo novo em `generatedFileSchema` aparece nos dois
      lados ou em nenhum. Escrever o JSON Schema à mão criaria a segunda verdade
      mais cara possível — servidor obrigando uma forma, produto conferindo
      outra.
    */
    expect([...arquivos.required].sort()).toEqual(Object.keys(generatedFileSchema.shape).sort())
  })

  it('o corpo leva o schema, não estrutura livre, e não pede fluxo', () => {
    const corpo = corpoEstruturado('qwen2.5-coder:7b', 'gere', 0)
    expect(corpo.stream).toBe(false)
    expect(corpo.format).toEqual(esquemaJsonDaSaida())
    expect(corpo.options.temperature).toBe(0)
  })

  it('o teto de saída é ALTO, e isso é a lição da primeira medição', () => {
    /*
      A primeira resposta estruturada parou em 1.133 tokens com o aplicativo
      pela metade — e o servidor FECHOU o JSON por cima do corte. Resposta
      válida e incompleta é pior que inválida: ela passa no schema.
    */
    expect(corpoEstruturado('m', 'p').options.num_predict).toBe(TETO_DE_SAIDA)
    expect(TETO_DE_SAIDA).toBeGreaterThan(2000)
  })
})

describe('a leitura da resposta do servidor', () => {
  it('lê o texto e a contagem', () => {
    const lido = leituraDaResposta({ response: '{}', prompt_eval_count: 854, eval_count: 1133 })
    expect(lido.texto).toBe('{}')
    expect(lido.uso).toEqual({ inputTokens: 854, outputTokens: 1133 })
  })

  it('DENUNCIA o corte por teto, que o schema não consegue ver', () => {
    // `done_reason: length` é o servidor dizendo que parou por limite. Com
    // gramática, a resposta ainda sai fechada — então nem `JSON.parse` nem o
    // schema percebem que falta metade do aplicativo.
    expect(leituraDaResposta({ response: '{"files":[]}', done_reason: 'length' }).cortado).toBe(true)
    expect(leituraDaResposta({ response: '{"files":[]}', done_reason: 'stop' }).cortado).toBe(false)
  })

  it('recusa um corpo que não é a resposta do servidor', () => {
    expect(() => leituraDaResposta({ erro: 'model not found' })).toThrow(SaidaEstruturadaIndisponivel)
  })

  it('a contagem parcial NÃO vira número inventado', () => {
    // Metade da contagem é ausência de contagem: relatar entrada com saída zero
    // faria o orçamento acreditar que a geração foi de graça.
    expect(leituraDaResposta({ response: '{}', prompt_eval_count: 10 }).uso).toBeUndefined()
  })
})

describe('os pedaços que o desvio devolve ao harness', () => {
  it('parecem, para quem monta blocos, uma resposta normal', () => {
    const pedacos = pedacosDaResposta('conteudo', { inputTokens: 1, outputTokens: 2 })
    expect(pedacos.map(pedaco => pedaco.type)).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  })

  it('sem contagem, o pedaço de uso não existe — e não vira zero', () => {
    expect(pedacosDaResposta('x').map(pedaco => pedaco.type)).not.toContain('usage')
  })
})

describe('a marca vive fora do objeto, e é consumida', () => {
  const requisicao = () => ({ provider: 'ollama', model: 'm', messages: [] }) as never

  it('quem não foi marcado não é desviado', () => {
    expect(consumirMarca(requisicao())).toBe(false)
  })

  it('quem foi marcado é desviado UMA vez', () => {
    const pedido = requisicao()
    marcarEstruturada(pedido)
    expect(consumirMarca(pedido)).toBe(true)
    // Consumir evita que um repetidor herde a decisão de outra requisição.
    expect(consumirMarca(pedido)).toBe(false)
  })

  it('a marca NÃO escreve no objeto — ele chega congelado do laço de agente', () => {
    const pedido = Object.freeze(requisicao())
    expect(() => marcarEstruturada(pedido)).not.toThrow()
    expect(consumirMarca(pedido)).toBe(true)
  })
})

describe('o texto que desce para o `/api/generate`', () => {
  const pedido = (messages: unknown, system?: string) =>
    ({ provider: 'ollama', model: 'm', messages, ...(system === undefined ? {} : { system }) }) as never
  const texto = (conteudo: string) => ({ role: 'user', content: [{ type: 'text', text: conteudo }] })

  it('uma mensagem de texto só vira o prompt', () => {
    expect(textoDeUmaMensagem(pedido([texto('gere')]))).toBe('gere')
  })

  it('o `system` entra na frente, porque o endpoint nativo não tem papéis', () => {
    expect(textoDeUmaMensagem(pedido([texto('gere')], 'seja breve'))).toBe('seja breve\ngere')
  })

  it('uma CONVERSA não é achatada — o desvio simplesmente não se aplica', () => {
    /*
      Achatar várias mensagens em um parágrafo perderia quem falou o quê, e o
      desvio existe para a requisição que ESTE plugin monta: um texto só, de um
      autor só. Qualquer outra forma segue pelo adaptador normal.
    */
    expect(textoDeUmaMensagem(pedido([texto('a'), texto('b')]))).toBeUndefined()
    expect(textoDeUmaMensagem(pedido([{ role: 'assistant', content: [{ type: 'text', text: 'a' }] }]))).toBeUndefined()
  })

  it('conteúdo que não é texto também não é achatado', () => {
    const comImagem = { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image', ref: 'x' }] }
    expect(textoDeUmaMensagem(pedido([comImagem]))).toBeUndefined()
    expect(textoDeUmaMensagem(pedido([]))).toBeUndefined()
  })
})

describe('o endereço nativo sai do endereço que a instalação já tem', () => {
  it('a rota compatível `/v1` vira o `/api/generate` do mesmo servidor', () => {
    // O campo `format` não existe no dialeto compatível com a OpenAI: ele é do
    // endpoint nativo. Derivar evita que uma instalação aponte as duas para
    // servidores diferentes.
    expect(enderecoNativo('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/api/generate')
    expect(enderecoNativo('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434/api/generate')
    expect(enderecoNativo('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434/api/generate')
  })

  it('sem endereço não há desvio — e não há endereço inventado', () => {
    expect(enderecoNativo(undefined)).toBeUndefined()
    expect(enderecoNativo('   ')).toBeUndefined()
  })
})

describe('a geração estruturada contra o servidor', () => {
  const servidor = (resposta: unknown, ok = true) => ({
    endereco: 'http://x/api/generate',
    enviado: [] as string[],
    buscar: async function (this: { enviado: string[] }, _entrada: string, inicio: { body: string }) {
      this.enviado.push(inicio.body)
      return { ok, status: ok ? 200 : 500, json: async () => resposta }
    },
  })

  it('envia o schema e devolve o texto', async () => {
    const alvo = servidor({ response: '{"files":[]}', prompt_eval_count: 2, eval_count: 3 })
    const lido = await gerarEstruturado(alvo, 'qwen2.5-coder:7b', 'gere')
    expect(lido.texto).toBe('{"files":[]}')
    expect(JSON.parse(alvo.enviado[0] ?? '{}')).toMatchObject({ model: 'qwen2.5-coder:7b', stream: false })
    expect(JSON.parse(alvo.enviado[0] ?? '{}').format).toEqual(esquemaJsonDaSaida())
  })

  it('falha ALTO quando o servidor recusa — quem chama precisa saber que voltou', async () => {
    /*
      O corpo aqui é PLAUSÍVEL de propósito. Com um corpo qualquer, a leitura
      recusaria sozinha e o teste passaria sem nunca exercitar o `resposta.ok` —
      foi o que a sabotagem mostrou na primeira versão deste caso. Um servidor
      que devolve 500 com um corpo bem formado é justamente o caso em que só o
      código de status sabe que deu errado.
    */
    const plausivel = { response: '{"files":[{"path":"src/A.tsx","content":"x"}]}' }
    await expect(gerarEstruturado(servidor(plausivel, false), 'm', 'p')).rejects.toThrow(SaidaEstruturadaIndisponivel)
  })
})

describe('o DESVIO: quem ele atende, e quem ele deixa passar', () => {
  const RESPOSTA = { response: '{"files":[{"path":"src/A.tsx","content":"export const A = () => <div />"}]}' }
  const montar = (resposta: unknown = RESPOSTA, ok = true) => {
    const chamadas = { desvio: 0, normal: 0 }
    const ouvinte = desvioEstruturado({
      enderecoLocal: 'http://127.0.0.1:11434/v1',
      rotaLocal: 'ollama',
      buscar: async () => { chamadas.desvio += 1; return { ok, status: ok ? 200 : 500, json: async () => resposta } },
    })
    const normal = async function* () { chamadas.normal += 1; yield { type: 'text-delta', index: 0, text: 'pelo adaptador' } as never }
    return { chamadas, ouvinte, normal }
  }
  const pedido = (provider = 'ollama') => ({
    provider, model: 'qwen2.5-coder:7b', temperature: 0,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'gere' }] }],
  }) as never
  const juntar = async (fluxo: AsyncIterable<unknown>) => {
    const lidos: unknown[] = []
    for await (const pedaco of fluxo) lidos.push(pedaco)
    return lidos
  }

  it('uma requisição MARCADA para a rota local vai pelo caminho estruturado', async () => {
    const { chamadas, ouvinte, normal } = montar()
    const lidos = await juntar(ouvinte(marcarEstruturada(pedido()), normal))
    expect(chamadas).toEqual({ desvio: 1, normal: 0 })
    expect(lidos.map(pedaco => (pedaco as { type: string }).type)).toContain('block-end')
  })

  it('uma requisição NÃO marcada passa direto — `intake` e `plan` conversam, não devolvem JSON', async () => {
    const { chamadas, ouvinte, normal } = montar()
    await juntar(ouvinte(pedido(), normal))
    expect(chamadas).toEqual({ desvio: 0, normal: 1 })
  })

  it('outra rota passa direto, mesmo marcada — só o servidor local aceita `format`', async () => {
    const { chamadas, ouvinte, normal } = montar()
    await juntar(ouvinte(marcarEstruturada(pedido('deepseek-official')), normal))
    expect(chamadas).toEqual({ desvio: 0, normal: 1 })
  })

  it('a marca é consumida MESMO quando o desvio não acontece', async () => {
    // Deixá-la para trás faria a próxima requisição que reutilizasse o objeto
    // herdar uma decisão que não é dela.
    const { ouvinte, normal } = montar()
    const requisicao = marcarEstruturada(pedido('deepseek-official'))
    await juntar(ouvinte(requisicao, normal))
    expect(consumirMarca(requisicao)).toBe(false)
  })

  it('servidor fora do ar VOLTA para o adaptador, e AVISA', async () => {
    const avisos: string[] = []
    const chamadas = { normal: 0 }
    const ouvinte = desvioEstruturado({
      enderecoLocal: 'http://127.0.0.1:11434/v1', rotaLocal: 'ollama',
      buscar: async () => { throw new Error('ECONNREFUSED') },
      avisar: motivo => avisos.push(motivo),
    })
    const normal = async function* () { chamadas.normal += 1; yield { type: 'text-delta', index: 0, text: 'x' } as never }
    await juntar(ouvinte(marcarEstruturada(pedido()), normal))
    expect(chamadas.normal).toBe(1)
    // Um desvio que silenciosamente para de funcionar vira regressão invisível:
    // o resultado continua saindo, só que pior.
    expect(avisos).toEqual(['ECONNREFUSED'])
  })

  it('resposta CORTADA por teto volta para o adaptador em vez de virar aplicativo pela metade', async () => {
    const avisos: string[] = []
    const chamadas = { normal: 0 }
    const ouvinte = desvioEstruturado({
      enderecoLocal: 'http://x/v1', rotaLocal: 'ollama',
      buscar: async () => ({ ok: true, status: 200, json: async () => ({ ...RESPOSTA, done_reason: 'length' }) }),
      avisar: motivo => avisos.push(motivo),
    })
    const normal = async function* () { chamadas.normal += 1; yield { type: 'text-delta', index: 0, text: 'x' } as never }
    await juntar(ouvinte(marcarEstruturada(pedido()), normal))
    expect(chamadas.normal).toBe(1)
    expect(avisos).toEqual(['SAIDA_ESTRUTURADA_CORTADA'])
  })

  it('sem endereço local configurado, o desvio simplesmente não existe', async () => {
    const chamadas = { desvio: 0, normal: 0 }
    const ouvinte = desvioEstruturado({
      enderecoLocal: undefined, rotaLocal: 'ollama',
      buscar: async () => { chamadas.desvio += 1; return { ok: true, status: 200, json: async () => RESPOSTA } },
    })
    const normal = async function* () { chamadas.normal += 1; yield { type: 'text-delta', index: 0, text: 'x' } as never }
    await juntar(ouvinte(marcarEstruturada(pedido()), normal))
    expect(chamadas).toEqual({ desvio: 0, normal: 1 })
  })
})
