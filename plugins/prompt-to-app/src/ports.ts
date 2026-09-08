import { BlockAssembler, createUserMessage, type GenerateOptions, type LlmRuntime, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { StudioRouteHealthService } from '@dz23-studio/route-health'
import type { RoutePrivacy, RouteScope } from '@dz23-studio/route-health'
import { t } from './i18n.js'

export interface ModelResult {
  readonly value: unknown
  readonly route: string
  readonly model: string
  readonly usage?: TokenUsage
}

export interface PromptModelPort {
  complete(scope: RouteScope, purpose: 'intake' | 'plan' | 'generate', privacy: RoutePrivacy, prompt: string): Promise<ModelResult>
}

export interface HarnessModelPortOptions {
  readonly llm: LlmRuntime
  readonly routes: StudioRouteHealthService
  readonly modelByRoute: Readonly<Record<string, string>>
  readonly markScope?: (options: GenerateOptions, scope: RouteScope) => GenerateOptions
  /**
   * Carimba o perfil na requisição antes de ela subir para o runtime.
   *
   * A escolha da rota respeita o perfil, mas a CASCATA acontece depois, dentro
   * do runtime, onde o perfil já não está em lugar nenhum. Sem este carimbo o
   * `privado-local` escolheria a rota local corretamente e desceria para a
   * externa assim que ela falhasse.
   */
  readonly markPrivacy?: (options: GenerateOptions, privacy: RoutePrivacy) => GenerateOptions
}

export class ModelRouteUnavailableError extends Error {
  readonly code = 'MODEL_ROUTE_UNAVAILABLE'
}

export class HarnessPromptModel implements PromptModelPort {
  constructor(private readonly options: HarnessModelPortOptions) {}

  async complete(scope: RouteScope, purpose: 'intake' | 'plan' | 'generate', privacy: RoutePrivacy, prompt: string): Promise<ModelResult> {
    const selected = await this.options.routes.chooseRoute(scope, purpose, { privacy })
    if (selected.route === undefined) throw new ModelRouteUnavailableError(selected.reason)
    const model = this.options.modelByRoute[selected.route]
    if (model === undefined) throw new ModelRouteUnavailableError(t('errors.routeModel'))
    const assembler = new BlockAssembler()
    const options: GenerateOptions = {
      provider: selected.route,
      model,
      messages: [createUserMessage({ source: { kind: 'plugin', plugin: 'dz23-studio-prompt-to-app' }, content: [{ type: 'text', text: prompt }] })],
      temperature: 0,
    }
    const scoped = this.options.markScope?.(options, scope) ?? options
    const marked = this.options.markPrivacy?.(scoped, privacy) ?? scoped
    for await (const chunk of this.options.llm.stream(marked)) assembler.push(chunk)
    if (assembler.finish.kind === 'error' || assembler.finish.kind === 'aborted') {
      throw new ModelRouteUnavailableError(assembler.finish.failure.message)
    }
    const text = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('').trim()
    return { value: text, route: selected.route, model, ...(assembler.usage === undefined ? {} : { usage: assembler.usage }) }
  }
}
