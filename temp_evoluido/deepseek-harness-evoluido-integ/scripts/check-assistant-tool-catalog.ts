import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { ASSISTANT_ALLOWED_PROVIDERS, ASSISTANT_TOOL_NAMES, ASSISTANT_TOOL_POLICY, assertAssistantToolCatalog } from '../plugins/assistant-bridge/src/catalog.js'
import { StudioPolicyEngine, type ToolPolicyRule } from '../plugins/policy/src/index.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const preset = await readFile(resolve(root, 'dsh-home/.agent-presets/dz23-assistant/agent.cordis.yml'), 'utf8')
const profile = await readFile(resolve(root, 'dsh-home/profiles/studio/cordis.patch.yml'), 'utf8')

const exposedBlock = preset.match(/\n\s+exposedTools:\n(?<items>(?:\s+- [a-z0-9_-]+\n)+)/)?.groups?.items ?? ''
const exposed = [...exposedBlock.matchAll(/^\s+- ([a-z0-9_-]+)$/gm)].map(match => match[1]!)
const rulesBlock = profile.match(/\n        rules:\n(?<rules>[\s\S]*?)\n    - id: dz23-studio-identity/)?.groups?.rules ?? ''
const classified = [...rulesBlock.matchAll(/^          ([a-z0-9_-]+):$/gm)].map(match => match[1]!)

assertAssistantToolCatalog(exposed, classified)
if (JSON.stringify(ASSISTANT_ALLOWED_PROVIDERS) !== JSON.stringify(['spawn-in-process'])) {
  throw new Error(`A ponte P36 anunciou provider sem prova de confinamento: ${ASSISTANT_ALLOWED_PROVIDERS.join(',')}`)
}
const effectiveRules = Object.fromEntries(ASSISTANT_TOOL_NAMES.map(name => [name, parseEffectiveRule(name, rulesBlock)]))
assertEffectiveRules(effectiveRules)
const engine = new StudioPolicyEngine({ requireAuthorizationDeclarations: true, rules: effectiveRules })
for (const name of ASSISTANT_TOOL_NAMES) {
  const decision = engine.evaluate(name, {
    strongIdentityVerified: true,
    authorization: { userId: 'gate', orgId: 'gate', tenantId: 'gate', role: 'builder' },
  })
  if (decision.kind === 'deny') throw new Error(`${name} foi negada pelo catálogo efetivo: ${decision.reason}`)
}

let mutationFailed = false
try {
  assertAssistantToolCatalog(exposed, classified.filter(name => name !== ASSISTANT_TOOL_NAMES[0]))
} catch {
  mutationFailed = true
}
if (!mutationFailed) throw new Error('O self-test negativo não detectou a remoção de uma regra.')

let valueMutationFailed = false
try {
  assertEffectiveRules({
    ...effectiveRules,
    studio_agent_start_sensitive: { ...effectiveRules.studio_agent_start_sensitive!, inferredTier: 'T0' },
  })
} catch {
  valueMutationFailed = true
}
if (!valueMutationFailed) throw new Error('O self-test negativo não detectou mutação T3→T0 no perfil efetivo.')

let sourceMutationFailed = false
try {
  assertEffectiveRules({
    ...effectiveRules,
    studio_agent_start: {
      ...effectiveRules.studio_agent_start!,
      source: { kind: 'studio', stableChannel: true } as ToolPolicyRule['source'],
    },
  })
} catch {
  sourceMutationFailed = true
}
if (!sourceMutationFailed) throw new Error('O self-test negativo não detectou remoção de source.external.')

process.stdout.write(`ASSISTANT_TOOL_CATALOG=PASS tools=${ASSISTANT_TOOL_NAMES.length} providers=spawn-in-process negativeRemoval=PASS negativeValueMutation=PASS negativeSourceMutation=PASS\n`)

function parseEffectiveRule(name: string, source: string): ToolPolicyRule {
  const marker = `          ${name}:`
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`Regra efetiva ausente para ${name}.`)
  const remainder = source.slice(start + marker.length).replace(/^\r?\n/, '')
  const nextRule = remainder.search(/^          [a-z0-9_-]+:/m)
  const block = nextRule < 0 ? remainder : remainder.slice(0, nextRule)
  const value = (key: string): string => {
    const found = block.match(new RegExp(`^            ${key}:\\s*([^\\r\\n]+)$`, 'm'))?.[1]?.trim()
    if (found === undefined) throw new Error(`Regra ${name} não declara ${key}.`)
    return found
  }
  const sourceLine = value('source')
  const sourceFields = Object.fromEntries([...sourceLine.matchAll(/([a-zA-Z]+):\s*([^,}]+)/g)].map(match => [match[1], match[2]?.trim()]))
  const sourceKeys = Object.keys(sourceFields).sort()
  if (JSON.stringify(sourceKeys) !== JSON.stringify(['external', 'kind', 'stableChannel'])) {
    throw new Error(`Regra ${name} precisa declarar exatamente source.kind, source.external e source.stableChannel.`)
  }
  if (sourceFields.kind !== 'studio' || !['true', 'false'].includes(sourceFields.external!)
    || !['true', 'false'].includes(sourceFields.stableChannel!)) {
    throw new Error(`Regra ${name} contém valores inválidos em source.`)
  }
  return {
    source: {
      kind: sourceFields.kind as 'studio',
      external: sourceFields.external === 'true',
      stableChannel: sourceFields.stableChannel === 'true',
    },
    inferredTier: value('inferredTier') as ToolPolicyRule['inferredTier'],
    sandboxMode: value('sandboxMode') as ToolPolicyRule['sandboxMode'],
    requiredPermission: value('requiredPermission') as NonNullable<ToolPolicyRule['requiredPermission']>,
    scope: value('scope') as NonNullable<ToolPolicyRule['scope']>,
  }
}

function assertEffectiveRules(actual: Record<string, ToolPolicyRule>): void {
  for (const name of ASSISTANT_TOOL_NAMES) {
    const expected = ASSISTANT_TOOL_POLICY[name]
    const candidate = actual[name]
    if (candidate === undefined || JSON.stringify(candidate) !== JSON.stringify(expected)) {
      throw new Error(`Regra efetiva divergente para ${name}: esperado=${JSON.stringify(expected)} atual=${JSON.stringify(candidate)}`)
    }
  }
}
