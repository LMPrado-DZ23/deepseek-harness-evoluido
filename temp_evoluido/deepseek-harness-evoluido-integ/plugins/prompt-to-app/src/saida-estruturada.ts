import { z } from 'zod'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { generatedFileSchema } from './generator.js'
import { t } from './i18n.js'

/**
 * A SAÍDA ESTRUTURADA do servidor local, e por que ela não chegava até aqui.
 *
 * ## O que foi medido, em 18/09/2026, contra o Ollama do titular
 *
 * O MESMO prompt de geração, o MESMO modelo (`qwen2.5:3b`), a MESMA temperatura:
 *
 * | envio | resposta | `decodeModelJson` |
 * | --- | --- | --- |
 * | livre | bloco cercado cujo JSON tem quebras de linha CRUAS dentro da string | recusa: JSON inválido |
 * | com `format` | JSON válido, fechado pelo servidor, e aprovado pelo schema | aceita |
 *
 * A diferença não é de sorte: com `format`, o servidor restringe a DECODIFICAÇÃO
 * à gramática do schema — o modelo não consegue emitir uma quebra de linha crua
 * dentro de uma string porque a gramática não a permite. A classe de falha
 * "modelo escreveu JSON quase certo" deixa de existir na origem, em vez de ser
 * remendada depois.
 *
 * ## Por que ela precisava de um caminho novo
 *
 * O `GenerateOptions` do harness — que é upstream FIXADO, com zero diff — não
 * tem campo nenhum de saída estruturada, e o adaptador pi-ai que atende a rota
 * `ollama` nunca emite um. Não havia por onde a informação descer.
 *
 * Mexer no upstream está proibido, e com razão. O que existe é o ponto de
 * extensão documentado: o waterfall `llm/stream` diz, com estas palavras, que
 * um ouvinte pode "yield your own chunks to short-circuit". Este arquivo é a
 * lógica PURA desse atalho — montar o corpo, ler a resposta, decidir se a
 * requisição merece o desvio — e quem o liga ao contexto é o `index.ts`.
 *
 * ## O que ele NÃO faz
 *
 * Não valida semântica. A gramática garante que o texto é JSON com a FORMA
 * pedida; ela não garante que os caminhos são permitidos, que os imports
 * existem ou que o código é aceitável. Medido no mesmo dia: a resposta
 * estruturada passou no schema e foi RECUSADA pela política de imports, que é
 * exatamente o que tinha de acontecer. `decodeModelJson`,
 * `generatedOutputSchema`, `assertGeneratedSource` e a varredura de segurança
 * continuam todos no caminho, na mesma ordem, depois daqui.
 */

/** O contrato de saída, em JSON Schema, para o servidor restringir a gramática. */
export const esquemaDaSaidaGerada = z.object({
  files: z.array(generatedFileSchema).min(1).max(80),
}).strict()

/**
 * O JSON Schema que vai no campo `format`.
 *
 * Ele é DERIVADO do mesmo schema Zod que valida a resposta depois. Escrevê-lo à
 * mão criaria a segunda verdade mais cara possível: o servidor obrigaria uma
 * forma e o produto conferiria outra, e a divergência só apareceria quando
 * alguém acrescentasse um campo em um dos dois.
 * @returns o JSON Schema do objeto de saída.
 */
export function esquemaJsonDaSaida(): Record<string, unknown> {
  return esquemaDaSaidaGerada.toJSONSchema() as Record<string, unknown>
}

/** O corpo de `POST /api/generate`, do jeito que o Ollama nativo o espera. */
export interface CorpoEstruturado {
  readonly model: string
  readonly prompt: string
  readonly stream: false
  readonly format: Record<string, unknown>
  readonly options: { readonly temperature: number; readonly num_predict: number; readonly num_ctx: number }
}

/** Quantos tokens de resposta um aplicativo inteiro precisa caber. */
export const TETO_DE_SAIDA = 8192

/**
 * A JANELA de contexto pedida ao servidor local: prompt + resposta.
 *
 * Sem ela, o Ollama usa a janela padrão dele (4.096 tokens nesta instalação —
 * medido em 19/09/2026 com `ollama ps`), e `num_predict` alto não adianta: o
 * prompt de geração tem ~2.300 tokens, sobram ~1.800 para a resposta, e o
 * aplicativo era cortado no meio. Na primeira criação real no WSL2 a tentativa
 * 1 morreu com "JSON inválido" exatamente assim. O `qwen2.5-coder:7b` aceita
 * 32k; 16k cabe o prompt e o `TETO_DE_SAIDA` inteiro com folga.
 */
export const JANELA_DE_CONTEXTO = 16_384

/**
 * O corpo da requisição estruturada.
 * @param modelo - o identificador do modelo no servidor local.
 * @param texto - o prompt já montado pelo gerador.
 * @param esquema - a gramática que a resposta tem de obedecer.
 * @param temperatura - a temperatura da requisição original.
 * @returns o corpo pronto para virar JSON.
 */
export function corpoEstruturado(modelo: string, texto: string, esquema: Record<string, unknown>, temperatura = 0): CorpoEstruturado {
  return {
    model: modelo,
    prompt: texto,
    stream: false,
    format: esquema,
    /*
      O teto é ALTO de propósito. A primeira medição estruturada parou em 1.133
      tokens com o aplicativo pela metade, e o servidor fechou o JSON por cima
      do corte — resposta VÁLIDA e INCOMPLETA, que é pior que inválida, porque
      passa no schema. Um teto apertado transforma a gramática em fabricante de
      truncamento silencioso.
    */
    options: { temperature: temperatura, num_predict: TETO_DE_SAIDA, num_ctx: JANELA_DE_CONTEXTO },
  }
}

/** O que o `/api/generate` devolve, na parte que interessa. */
const respostaSchema = z.object({
  response: z.string(),
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
  done_reason: z.string().optional(),
}).loose()

export class SaidaEstruturadaIndisponivel extends Error {
  readonly code = 'SAIDA_ESTRUTURADA_INDISPONIVEL'
}

/**
 * O texto e a contagem que vieram do servidor.
 * @param corpo - o JSON devolvido pelo `/api/generate`.
 * @returns o texto da resposta e o uso, quando o servidor o informou.
 */
export function leituraDaResposta(corpo: unknown): { readonly texto: string; readonly uso?: TokenUsage; readonly cortado: boolean } {
  const lido = respostaSchema.safeParse(corpo)
  if (!lido.success) throw new SaidaEstruturadaIndisponivel(t('errors.invalidJson'))
  const { response, prompt_eval_count: entrada, eval_count: saida, done_reason: motivo } = lido.data
  /*
    `length` é o servidor dizendo que PAROU por teto, e não porque terminou. Com
    `format`, a resposta ainda assim sai sintaticamente fechada, então nem o
    `JSON.parse` nem o schema percebem. Sem esta leitura, um aplicativo cortado
    no meio chegaria ao disco parecendo completo.
  */
  const cortado = motivo === 'length'
  const uso = entrada === undefined || saida === undefined ? undefined : { inputTokens: entrada, outputTokens: saida }
  return { texto: response, cortado, ...(uso === undefined ? {} : { uso }) }
}

/**
 * Os pedaços que o desvio devolve ao harness, no formato do `StreamChunk`.
 *
 * O atalho tem de parecer, para quem consome, exatamente igual a uma resposta
 * que veio pelo adaptador: mesmo bloco de texto, mesmo `usage`, mesmo `finish`.
 * Qualquer diferença aqui vira defeito em quem monta os blocos — e quem monta é
 * o `BlockAssembler` do harness, que este arquivo não controla.
 * @param texto - o texto da resposta.
 * @param uso - a contagem de tokens, quando houver.
 * @returns os pedaços, na ordem do contrato.
 */
export function pedacosDaResposta(texto: string, uso?: TokenUsage): readonly StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: texto },
    { type: 'block-end', index: 0, block: { type: 'text', text: texto } },
    ...(uso === undefined ? [] : [{ type: 'usage', usage: uso } satisfies StreamChunk]),
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * A marca que diz "esta requisição pode ir pelo caminho estruturado".
 *
 * WeakMap, e não campo no objeto: `GenerateOptions` é upstream fixado, e uma
 * requisição montada pelo laço de agente chega CONGELADA — escrever nela lança.
 * O `route-health` já marca escopo e privacidade deste mesmo jeito, pelo mesmo
 * motivo; este arquivo segue o padrão que já existe em vez de inventar um.
 */
const requisicoesEstruturadas = new WeakMap<GenerateOptions, Record<string, unknown>>()

/**
 * Marca a requisição.
 * @param options - a requisição.
 * @returns a mesma requisição, para encadear.
 */
export function marcarEstruturada(options: GenerateOptions, esquema: Record<string, unknown>): GenerateOptions {
  requisicoesEstruturadas.set(options, esquema)
  return options
}

/**
 * Se esta requisição foi marcada — e a marca é consumida na leitura.
 *
 * Consumir evita que uma requisição reaproveitada por um repetidor herde a
 * decisão de outra.
 * @param options - a requisição.
 * @returns verdadeiro quando ela estava marcada.
 */
export function consumirMarca(options: GenerateOptions): Record<string, unknown> | undefined {
  const esquema = requisicoesEstruturadas.get(options)
  requisicoesEstruturadas.delete(options)
  return esquema
}

/**
 * O texto que o servidor local deve receber como prompt.
 *
 * O `/api/generate` nativo não tem papéis: ele recebe UM texto. A requisição do
 * harness traz mensagens com blocos, e o desvio só serve para a requisição que
 * este plugin monta — um texto só, de um autor só. Qualquer outra forma devolve
 * `undefined`, e o chamador segue pelo caminho normal em vez de achatar uma
 * conversa inteira em um parágrafo.
 * @param options - a requisição.
 * @returns o texto, ou `undefined` quando a requisição não é dessa forma.
 */
export function textoDeUmaMensagem(options: GenerateOptions): string | undefined {
  if (options.messages.length !== 1) return undefined
  const [mensagem] = options.messages
  if (mensagem === undefined || mensagem.role !== 'user') return undefined
  const blocos = mensagem.content.filter(bloco => bloco.type === 'text')
  if (blocos.length !== mensagem.content.length || blocos.length === 0) return undefined
  const texto = blocos.map(bloco => bloco.text).join('\n')
  return options.system === undefined ? texto : `${options.system}\n${texto}`
}

/**
 * O endereço NATIVO, derivado do endereço compatível que a instalação já tem.
 *
 * A rota local é configurada como `.../v1` porque o adaptador fala o dialeto
 * compatível com a OpenAI. O campo `format` não existe nesse dialeto: ele é do
 * `/api/generate` nativo do Ollama. Derivar em vez de pedir uma segunda
 * variável evita que uma instalação aponte as duas para servidores diferentes —
 * e é o tipo de divergência que ninguém percebe até o dia em que percebe.
 * @param base - o endereço da rota local, com ou sem `/v1`.
 * @returns o endereço do `/api/generate`, ou `undefined` quando não há base.
 */
export function enderecoNativo(base: string | undefined): string | undefined {
  if (base === undefined || base.trim() === '') return undefined
  const limpo = base.trim().replace(/\/+$/u, '')
  const raiz = limpo.endsWith('/v1') ? limpo.slice(0, -'/v1'.length) : limpo
  return `${raiz}/api/generate`
}

/** Como alcançar o servidor local, com a busca injetada para o teste poder medir. */
export interface ServidorLocal {
  readonly endereco: string
  readonly buscar: (entrada: string, inicio: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>
}

/**
 * Uma geração estruturada contra o servidor local.
 *
 * Falha LOUD, e não em silêncio: quem chama tem de poder voltar para o caminho
 * normal sabendo que voltou. Um desvio que engole o erro e devolve texto vazio
 * faria o gerador queimar as três tentativas contra nada.
 * @param servidor - o endereço e a busca.
 * @param modelo - o modelo.
 * @param texto - o prompt.
 * @param temperatura - a temperatura.
 * @param signal - o cancelamento da requisição original.
 * @returns o texto, o uso e se a resposta foi cortada por teto.
 */
export async function gerarEstruturado(
  servidor: ServidorLocal, modelo: string, texto: string, esquema: Record<string, unknown>, temperatura = 0, signal?: AbortSignal,
): Promise<{ readonly texto: string; readonly uso?: TokenUsage; readonly cortado: boolean }> {
  const resposta = await servidor.buscar(servidor.endereco, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpoEstruturado(modelo, texto, esquema, temperatura)),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!resposta.ok) throw new SaidaEstruturadaIndisponivel(t('errors.routeModel'))
  return leituraDaResposta(await resposta.json())
}

/** O que o desvio precisa saber para existir. */
export interface OpcoesDoDesvio {
  /** O endereço da rota local, como a instalação o configurou; ausente desliga o desvio. */
  readonly enderecoLocal: string | undefined
  /** A rota que É a local. Uma requisição para qualquer outra passa direto. */
  readonly rotaLocal: string
  /** Como falar com o servidor; injetada para o teste poder medir sem rede. */
  readonly buscar: ServidorLocal['buscar']
  /** Onde registrar que o desvio não deu certo. Silêncio aqui esconde regressão. */
  readonly avisar?: (motivo: string) => void
}

/**
 * O DESVIO: o ouvinte de `llm/stream` que atende a geração pelo caminho estruturado.
 *
 * ## Por que um ouvinte, e não um adaptador
 *
 * O `llm/stream` do harness é um waterfall documentado como ponto de extensão:
 * um ouvinte chama `next()` para seguir até o adaptador, ou devolve os próprios
 * pedaços para curto-circuitar. É o lugar previsto para exatamente isto, e ele
 * não encosta no upstream fixado nem disputa a rota com o adaptador pi-ai, que
 * continua atendendo tudo o mais — inclusive esta mesma rota para `intake` e
 * `plan`, que conversam em vez de devolver JSON.
 *
 * ## O que ele faz quando dá errado
 *
 * Volta para `next()`. Um desvio que falha e derruba a geração seria pior que
 * não existir: o produto passaria a depender de um servidor falar um dialeto
 * específico. Ele avisa e sai do caminho — e avisar não é opcional, porque um
 * desvio que silenciosamente para de funcionar vira uma regressão que ninguém
 * vê, já que o resultado continua saindo, só que pior.
 * @param opcoes - o endereço, a rota e a busca.
 * @returns o ouvinte, pronto para `ctx.on('llm/stream', ...)`.
 */
export function desvioEstruturado(opcoes: OpcoesDoDesvio) {
  const endereco = enderecoNativo(opcoes.enderecoLocal)
  return function ouvinte(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    /*
      A MARCA é consumida SEMPRE, mesmo quando o desvio não vai acontecer.
      Deixá-la para trás faria a próxima requisição que reutilizasse este objeto
      herdar uma decisão que não é dela.
    */
    const esquema = consumirMarca(options)
    if (esquema === undefined || endereco === undefined || options.provider !== opcoes.rotaLocal) return next()
    const texto = textoDeUmaMensagem(options)
    if (texto === undefined) return next()
    return (async function* () {
      let lido: Awaited<ReturnType<typeof gerarEstruturado>>
      try {
        lido = await gerarEstruturado({ endereco, buscar: opcoes.buscar }, options.model, texto, esquema, options.temperature ?? 0, options.signal)
      } catch (erro) {
        opcoes.avisar?.((erro as Error).message)
        yield* next()
        return
      }
      /*
        Cortado por teto é uma resposta INCOMPLETA que a gramática fechou — ela
        passa no `JSON.parse` e no schema com metade do aplicativo dentro.
        Melhor voltar para o caminho normal e deixar a rodada de reparo
        acontecer do que gravar um aplicativo pela metade que parece inteiro.
      */
      if (lido.cortado) {
        opcoes.avisar?.('SAIDA_ESTRUTURADA_CORTADA')
        yield* next()
        return
      }
      yield* pedacosDaResposta(lido.texto, lido.uso)
    })()
  }
}
