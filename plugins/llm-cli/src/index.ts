import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { acharNoPath, ambienteSemSegredos, executar, FERRAMENTAS_CONHECIDAS, MODELO_PADRAO, transcricao, type Execucao, type FerramentaDeLinha } from './cli.js'
import { t } from './i18n.js'

export * from './cli.js'

export const name = 'dz23-studio-llm-cli'
export const inject = ['llm']

export interface LlmCliConfig {
  /** Quanto uma resposta pode demorar. Uma criação inteira leva minutos. */
  readonly tempoMs?: number
  /** O teto da saída de uma resposta. */
  readonly maxBytes?: number
  /** Desliga a procura (a conexão fica sem nenhuma rota). */
  readonly desligado?: boolean
}

export const TEMPO_PADRAO_MS = 15 * 60_000
export const MAX_BYTES_PADRAO = 4 * 1024 * 1024

/** Uma ferramenta que a procura achou, com o caminho do executável. */
export interface FerramentaEncontrada extends FerramentaDeLinha {
  readonly caminho: string
}

/**
 * As ferramentas instaladas, na ordem de `FERRAMENTAS_CONHECIDAS`.
 * @param path - o PATH.
 * @param executavel - o teste de execução (o real por padrão).
 * @returns as encontradas.
 */
export function procurarFerramentas(path: string | undefined, executavel?: (caminho: string) => boolean): readonly FerramentaEncontrada[] {
  return FERRAMENTAS_CONHECIDAS.flatMap(ferramenta => {
    const caminho = acharNoPath(ferramenta.comando, path, executavel)
    return caminho === undefined ? [] : [{ ...ferramenta, caminho }]
  })
}

/**
 * Os argumentos de UMA chamada: os fixos e, quando a pessoa escolheu um modelo
 * da ferramenta, o modelo.
 * @param ferramenta - a ferramenta.
 * @param modelo - o modelo pedido.
 * @returns a lista de argumentos.
 */
export function argumentosDaChamada(ferramenta: FerramentaDeLinha, modelo: string): readonly string[] {
  return modelo === MODELO_PADRAO ? ferramenta.argumentos : [...ferramenta.argumentos, ferramenta.argumentoDeModelo, modelo]
}

/**
 * O adaptador: uma chamada ao modelo vira UMA execução da ferramenta.
 *
 * Cada execução roda numa pasta temporária VAZIA, apagada no fim — a
 * ferramenta não vê o disco do FRIGG nem os arquivos da pessoa, mesmo que
 * algum argumento de só-leitura mude numa versão futura dela.
 */
export class AdaptadorDeLinha extends LlmAdapter {
  readonly #porRota: ReadonlyMap<string, FerramentaEncontrada>

  constructor(
    ferramentas: readonly FerramentaEncontrada[],
    private readonly limites: { readonly tempoMs: number; readonly maxBytes: number },
    private readonly ambiente: Readonly<Record<string, string | undefined>>,
    private readonly rodar: (execucao: Execucao) => Promise<string> = executar,
  ) {
    super()
    this.#porRota = new Map(ferramentas.map(ferramenta => [ferramenta.rota, ferramenta]))
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: t(`nomes.${provider}`) }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: MODELO_PADRAO, name: t('modelos.padrao') }])
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const ferramenta = this.#porRota.get(options.provider)
    if (ferramenta === undefined) throw new Error(t('errors.rotaDesconhecida', { rota: options.provider }))
    const pasta = await mkdtemp(join(tmpdir(), 'frigg-cli-'))
    let texto: string
    try {
      texto = await this.rodar({
        caminho: ferramenta.caminho, comando: ferramenta.comando,
        argumentos: argumentosDaChamada(ferramenta, options.model),
        entrada: transcricao(options), pasta,
        ambiente: ambienteSemSegredos(this.ambiente),
        tempoMs: this.limites.tempoMs, maxBytes: this.limites.maxBytes,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } finally {
      await rm(pasta, { recursive: true, force: true })
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: texto }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: texto } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function apply(ctx: Context, config: LlmCliConfig = {}): void {
  if (config.desligado === true) return
  const encontradas = procurarFerramentas(process.env.PATH)
  if (encontradas.length === 0) return
  const adaptador = new AdaptadorDeLinha(encontradas, {
    tempoMs: config.tempoMs ?? TEMPO_PADRAO_MS,
    maxBytes: config.maxBytes ?? MAX_BYTES_PADRAO,
  }, process.env)
  ctx.llm.registerAdapter(encontradas.map(ferramenta => ferramenta.rota), adaptador)
  ctx.logger.info(t('avisos.encontradas', { rotas: encontradas.map(ferramenta => ferramenta.rota).join(', ') }))
}
