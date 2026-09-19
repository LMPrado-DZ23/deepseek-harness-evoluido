import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
  O AGENTE GERAL (preset dz23-assistant, 19/09/2026): toda ferramenta que o
  preset monta tem regra na política do perfil.

  A política do Studio recusa ferramenta sem regra
  (`requireAuthorizationDeclarations: true`). Antes desta fatia o preset montava
  `tool-skill` e NÃO havia regra para `skill` — a ferramenta existia no catálogo
  e toda chamada era recusada. Esta lista é a das ferramentas que cada plugin
  do Harness fixado registra (conferidas no código de third_party).
*/
const raiz = resolve(__dirname, '../../..')
const preset = readFileSync(resolve(raiz, 'dsh-home/.agent-presets/dz23-assistant/agent.cordis.yml'), 'utf8')
const perfil = readFileSync(resolve(raiz, 'dsh-home/profiles/studio/cordis.patch.yml'), 'utf8')
const politica = perfil.slice(perfil.indexOf('id: dz23-studio-policy'))
const regras = new Set([...politica.matchAll(/^ {10}([a-z_]+):\s*$/gmu)].map(achado => achado[1]!))

const FERRAMENTAS_POR_PLUGIN: Readonly<Record<string, readonly string[]>> = {
  '@deepseek-ai/dsh-tool-bash': ['bash'],
  '@deepseek-ai/dsh-tool-fs': ['read', 'read_image', 'write', 'edit'],
  '@deepseek-ai/dsh-tool-fs-search': ['glob', 'grep'],
  '@deepseek-ai/dsh-tool-jobs': ['job_list', 'job_output', 'job_kill'],
  '@deepseek-ai/dsh-tool-goal': ['create_goal', 'get_goal', 'update_goal'],
  '@deepseek-ai/dsh-plan-mode': ['exit_plan_mode'],
  '@deepseek-ai/dsh-tool-subagent-control': ['send_message', 'interrupt_agent'],
  '@deepseek-ai/dsh-tool-subagent-control/list-agents': ['list_agents'],
  '@deepseek-ai/dsh-tool-subagent': ['subagent', 'list_subagent_models'],
  '@deepseek-ai/dsh-tool-workflow': ['workflow'],
  '@deepseek-ai/dsh-tool-ralph': ['ralph'],
  '@deepseek-ai/dsh-tool-ask-user': ['ask_user_question'],
  '@deepseek-ai/dsh-tool-todo': ['todo_write'],
  '@deepseek-ai/dsh-tool-web': ['web_search', 'web_fetch'],
  '@deepseek-ai/dsh-tool-skill': ['skill'],
}

const montados = [...preset.matchAll(/^\s*name: '(@deepseek-ai\/[^']+)'/gmu)].map(achado => achado[1]!)

describe('o preset do agente geral', () => {
  it('monta as ferramentas do agente geral', () => {
    for (const plugin of ['@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-web', '@deepseek-ai/dsh-tool-todo', '@deepseek-ai/dsh-plan-mode']) {
      expect(montados).toContain(plugin)
    }
  })

  it.each(montados.filter(plugin => FERRAMENTAS_POR_PLUGIN[plugin] !== undefined))('%s: toda ferramenta tem regra', plugin => {
    for (const ferramenta of FERRAMENTAS_POR_PLUGIN[plugin]!) expect(regras, ferramenta).toContain(ferramenta)
  })

  it('mudar arquivo ou rodar comando pede a pessoa (T2); ler não pede', () => {
    const nivel = (nome: string) => new RegExp(`^ {10}${nome}:\\s*\\n(?: {12}.*\\n)*? {12}inferredTier: (T\\d)`, 'mu').exec(politica)?.[1]
    for (const nome of ['bash', 'write', 'edit']) expect(nivel(nome), nome).toBe('T2')
    for (const nome of ['read', 'grep', 'glob', 'skill']) expect(nivel(nome), nome).toBe('T0')
  })
})

describe('o modelo padrão da conversa (19/09/2026: sem chave, a conversa parava em 116 ms sem dizer nada)', () => {
  const trecho = perfil.slice(perfil.indexOf('- id: agent-default-model'), perfil.indexOf('# The official DeepSeek route'))
  const expressao = (campo: string) => {
    const achado = new RegExp(`${campo}: !!js >-\\n((?: {6}.*\\n)+)`, 'u').exec(trecho)
    return achado![1]!.split('\n').map(linha => linha.trim()).join(' ')
  }
  const avaliar = (campo: string, env: Record<string, string>) => new Function('process', `return (${expressao(campo)})`)({ env }) as string

  it('com o Ollama configurado, a conversa nasce nele, com o modelo configurado', () => {
    const env = { DZ23_OLLAMA_BASE_URL: 'http://x/v1', DZ23_OLLAMA_MODEL: 'qwen2.5-coder:7b' }
    expect(avaliar('provider', env)).toBe('ollama')
    expect(avaliar('model', env)).toBe('qwen2.5-coder:7b')
  })

  it('sem Ollama, continua a rota oficial', () => {
    expect(avaliar('provider', {})).toBe('deepseek-official')
    expect(avaliar('model', {})).toBe('deepseek-v4-flash')
  })

  it('a escolha explícita vence', () => {
    const env = { DZ23_OLLAMA_BASE_URL: 'http://x/v1', DZ23_AGENT_PROVIDER: 'omniroute', DZ23_AGENT_MODEL: 'auto' }
    expect(avaliar('provider', env)).toBe('omniroute')
    expect(avaliar('model', env)).toBe('auto')
  })
})

describe('os modelos locais declarados: o das criações e o do agente', () => {
  const trecho = perfil.slice(perfil.indexOf('      ollama:'), perfil.indexOf('- insert:'))
  const expressao = /models: !!js >-\n((?: {10}.*\n)+)/u.exec(trecho)![1]!.split('\n').map(linha => linha.trim()).join(' ')
  const avaliar = (env: Record<string, string>) => new Function('process', `return (${expressao})`)({ env }) as { id: string }[]

  it('sem modelo do agente, só o das criações', () => {
    expect(avaliar({ DZ23_OLLAMA_MODEL: 'qwen2.5-coder:7b' }).map(m => m.id)).toEqual(['qwen2.5-coder:7b'])
  })

  it('com modelo do agente, os dois, sem repetir', () => {
    expect(avaliar({ DZ23_OLLAMA_MODEL: 'qwen2.5-coder:7b', DZ23_AGENT_MODEL: 'frigg-qwen3' }).map(m => m.id)).toEqual(['qwen2.5-coder:7b', 'frigg-qwen3'])
    expect(avaliar({ DZ23_OLLAMA_MODEL: 'x', DZ23_AGENT_MODEL: 'x' }).map(m => m.id)).toEqual(['x'])
  })
})
