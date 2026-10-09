import { createPublicKey, verify } from 'node:crypto'
import { hostBloqueado, hostCanonico, hostLoopback, type PolicyTier } from '@dz23-studio/policy'
import { z } from 'zod'

import { t } from './i18n.js'
import { declaresProvenance, integrationManifestSchema, type IntegrationKind, type IntegrationManifest, type IntegrationPermission } from './model.js'

export type ManifestVerification = 'verified' | 'unverified' | 'invalid'

export interface ManifestEvaluation {
  readonly manifest: IntegrationManifest | null
  readonly verification: ManifestVerification
  readonly effectiveTier: PolicyTier
  readonly reasons: readonly string[]
}

/** Publisher id → Ed25519 public key (SPKI, base64 or PEM). Public keys only: never a secret. */
export type PublisherKeys = Readonly<Record<string, string>>

const TIER_RANK: Readonly<Record<PolicyTier, number>> = { T0: 0, T1: 1, T2: 2, T3: 3 }

/** Anything below `verified` is capped at this floor, whatever the manifest declares (D16). */
export const UNVERIFIED_FLOOR: PolicyTier = 'T2'

/**
 * D16 policy floor, as a TABLE. Every kind and every permission the model can
 * carry names its floor here, so a permission added to `model.ts` without a
 * floor is a hole somebody has to open on purpose — the previous expression
 * only mentioned four permissions, and `filesystem.workspace` (read AND write
 * over the person's whole workspace) fell through it at T0.
 */
export const KIND_FLOOR: Readonly<Record<IntegrationKind, PolicyTier>> = {
  // The app's e-mail always leaves this computer, through somebody else's server.
  smtp: 'T2',
  // A local MCP server and a webhook act in the workspace's name: never below T1.
  mcp: 'T1',
  webhook: 'T1',
  // A skill on its own only reads; what raises it is what it asks for, below.
  skill: 'T0',
}

/**
 * Floor per declared permission. `filesystem.workspace` is T2 and not T1: it is
 * not one project's files, it is everything the person keeps in the workspace,
 * read and written — that deserves the same explicit confirmation as talking to
 * the outside world. `secrets.read` is T3 because a leaked credential cannot be
 * un-leaked.
 */
export const PERMISSION_FLOOR: Readonly<Record<IntegrationPermission, PolicyTier>> = {
  'read.project': 'T0',
  'write.project': 'T1',
  'filesystem.workspace': 'T2',
  'network.outbound': 'T2',
  'email.send': 'T2',
  'secrets.read': 'T3',
}

/**
 * Capacidade declarada (v2) → permissão que ela obriga a pedir, e piso.
 *
 * Um manifesto v2 diz DUAS coisas sobre a mesma realidade: o que ele pede
 * (`permissions`, que é o que o Studio concede) e o que ele diz que toca
 * (`capabilities`, que é o que a pessoa lê antes de ligar). Elas têm que
 * fechar. Quando não fecham, o documento está errado de um dos dois lados — e
 * o errado a fazer é NÃO escolher qual, e sim recusar tratá-lo como
 * verificado, porque a assinatura prova que o publicador escreveu aquilo, não
 * que aquilo é coerente.
 */
export const CAPABILITY_RULES = [
  { capability: 'network.egress', permission: 'network.outbound', floor: 'T2' },
  { capability: 'filesystem.write', permission: 'filesystem.workspace', floor: 'T2' },
  { capability: 'secrets', permission: 'secrets.read', floor: 'T3' },
] as const satisfies readonly { readonly capability: string, readonly permission: IntegrationPermission, readonly floor: PolicyTier }[]

/** As listas declaradas, por nome de capacidade, para uma regra poder olhar qualquer uma delas. */
function declaredLists(manifest: IntegrationManifest): Readonly<Record<string, readonly string[]>> {
  if (!declaresProvenance(manifest)) return {}
  return {
    'network.egress': manifest.capabilities.network.egress,
    'filesystem.write': manifest.capabilities.filesystem.write,
    secrets: manifest.capabilities.secrets,
  }
}

/**
 * Se o host do `endpoint` está coberto por uma das entradas da lista de egress.
 *
 * `*` casa UM rótulo e não atravessa ponto: `*.fornecedor.example` cobre
 * `api.fornecedor.example` e não cobre `a.b.fornecedor.example`. A leitura
 * apertada é de propósito — quem quis o segundo nível escreve as duas linhas, e
 * uma lista que cobre mais do que quem a leu imaginou não serve para decidir.
 * @param host - o host canônico do endereço, já em minúsculas.
 * @param padrao - uma entrada da lista `capabilities.network.egress`.
 * @returns `true` quando a entrada cobre o host.
 */
export function egressCobre(host: string, padrao: string): boolean {
  const partes = padrao.toLowerCase().split('*')
  const expressao = new RegExp(`^${partes.map(parte => parte.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)).join('[a-z0-9-]*')}$`, 'u')
  return expressao.test(host)
}

/**
 * A contradição que a revisão adversarial achou aberta: a lista de egress nunca
 * foi confrontada com o `endpoint`.
 *
 * O comentário de `evaluateManifest` dizia que ela era — descrevia o defeito
 * como corrigido logo acima da guarda que NÃO o corrige. É o achado das três
 * auditorias de novo: um comentário que afirma uma razão que o código não tem é
 * pior que nenhum, porque impede o próximo leitor de procurar.
 *
 * O ataque que isto fecha é curto: declarar `egress: ['api.fornecedor.example']`
 * — a lista limpa, que é o que a pessoa lê antes de ligar — e apontar o
 * `endpoint` para `exfil.atacante.example`. As duas metades passavam: a lista
 * fechava com a permissão pedida, e o endereço era público.
 *
 * Endereço de LOOPBACK fica fora: ele não sai da máquina, tem piso próprio, e
 * exigir que o modo pessoal se declare na lista de egress trocaria o
 * significado da lista.
 * @param manifest - o manifesto avaliado.
 * @returns as razões, já traduzidas, ou lista vazia quando fecha.
 */
export function endpointForaDoEgress(manifest: IntegrationManifest): readonly string[] {
  if (!declaresProvenance(manifest)) return []
  if (manifest.endpoint === undefined || isLoopbackEndpoint(manifest.endpoint)) return []
  let host: string
  try { host = hostCanonico(new URL(manifest.endpoint).hostname).texto } catch { return [] }
  const lista = manifest.capabilities.network.egress
  // Endereço externo sem NENHUM egress declarado é a mesma contradição na forma
  // mais clara: ela fala com a rede e o documento diz que não.
  if (lista.length === 0) return [t('manifest.reasonEndpointWithoutEgress', { host })]
  if (lista.some(padrao => egressCobre(host, padrao))) return []
  return [t('manifest.reasonEndpointOutsideEgress', { host })]
}

/**
 * As contradições entre o que o manifesto declara tocar e o que ele pede.
 *
 * Vale nos dois sentidos. Declarar egress sem pedir `network.outbound` é
 * prometer uma coisa e pedir outra; pedir `network.outbound` e não nomear
 * ninguém é pedir a internet inteira com a lista em branco, que é exatamente o
 * que a recusa do `*` no schema já impede escrever de forma explícita.
 * @param manifest - o manifesto avaliado.
 * @returns as razões, já traduzidas, ou lista vazia quando fecha.
 */
export function capabilityIncoherences(manifest: IntegrationManifest): readonly string[] {
  if (!declaresProvenance(manifest)) return []
  const lists = declaredLists(manifest)
  const reasons: string[] = []
  for (const rule of CAPABILITY_RULES) {
    const declared = lists[rule.capability]!.length > 0
    const asked = manifest.permissions.includes(rule.permission)
    if (declared && !asked) reasons.push(t('manifest.reasonCapabilityWithoutPermission', { capability: rule.capability, permission: rule.permission }))
    if (asked && !declared) reasons.push(t('manifest.reasonPermissionWithoutCapability', { permission: rule.permission }))
  }
  return [...reasons, ...endpointForaDoEgress(manifest)]
}

/** O piso que as capacidades declaradas impõem sozinhas, mesmo que a permissão correspondente não tenha sido pedida. */
export function capabilityFloor(manifest: IntegrationManifest): PolicyTier {
  const lists = declaredLists(manifest)
  let floor: PolicyTier = 'T0'
  for (const rule of CAPABILITY_RULES) if ((lists[rule.capability] ?? []).length > 0) floor = maxTier(floor, rule.floor)
  return floor
}

/** Any endpoint that is not loopback is "talks to the outside world", whatever the kind. */
export const EXTERNAL_ENDPOINT_FLOOR: PolicyTier = 'T2'

/**
 * The floor this manifest can never sit below: the most restrictive of its
 * kind, its endpoint and EVERY permission it declares. A kind or a permission
 * this build does not know is treated as T2, never as T0.
 */
export function policyFloor(kind: IntegrationKind, manifest: IntegrationManifest): PolicyTier {
  let floor = floorOf(KIND_FLOOR, kind)
  // The rule said so and the code only applied it to `mcp`, so a signed `webhook` (or a `skill`
  // with an endpoint) pointing anywhere was T1/T0 and turned on with no confirmation at all.
  if (manifest.endpoint !== undefined && !isLoopbackEndpoint(manifest.endpoint)) floor = maxTier(floor, EXTERNAL_ENDPOINT_FLOOR)
  for (const permission of manifest.permissions) floor = maxTier(floor, floorOf(PERMISSION_FLOOR, permission))
  // Defesa em profundidade: se declarou que toca, o piso sobe mesmo que não tenha pedido a permissão.
  return maxTier(floor, capabilityFloor(manifest))
}

/** A table lookup that cannot inherit from `Object.prototype` and never answers "no floor". */
function floorOf(table: Readonly<Record<string, PolicyTier>>, key: string): PolicyTier {
  return Object.hasOwn(table, key) ? table[key]! : UNVERIFIED_FLOOR
}

function maxTier(left: PolicyTier, right: PolicyTier): PolicyTier { return TIER_RANK[left] >= TIER_RANK[right] ? left : right }

/**
 * Se este endereço pode ser o destino de uma integração.
 *
 * Duas recusas, e as duas existem por um caminho concreto:
 *
 * 1. **Esquema.** `endpoint` era `z.string().url()` e nada mais — `file:`,
 *    `gopher:` e qualquer outro esquema passavam. A DUAS LINHAS de distância,
 *    no mesmo arquivo de modelo, `source_url` já era restrito a http(s) com a
 *    justificativa escrita ("um `file:` seria o disco de quem hospeda"). O
 *    endereço com quem a integração de fato FALA não tinha essa restrição.
 * 2. **Host.** Nada confrontava o endereço com faixa interna, então um
 *    manifesto assinado apontando para `http://169.254.169.254/` era aceito
 *    como coerente e entregue inteiro ao despachante.
 *
 * A DECISÃO não mora mais aqui: ela é `hostBloqueado`, sobre a forma CANÔNICA
 * do host, em `host.ts`. Enquanto ela morou numa lista de regex comparada com o
 * texto, três escritas do mesmo endereço interno passavam — o IPv4 mapeado em
 * IPv6, o nome absoluto com ponto final, e a faixa 100.64/10 que ninguém tinha
 * listado. Ver o comentário de abertura de `host.ts`.
 *
 * O LOOPBACK DE VERDADE continua permitido, e isso é decisão, não esquecimento:
 * um servidor MCP rodando na própria máquina é caso suportado — é o modo
 * pessoal — e tem nível próprio em `isLoopbackEndpoint`.
 *
 * O que isto NÃO resolve está dito em OS-30: a recusa é pelo NOME que o
 * manifesto escreveu, e um nome público que RESOLVE para endereço interno passa
 * por aqui. Fechar isso exige decidir no momento da conexão, dentro de quem
 * fala o protocolo, e não na leitura do manifesto.
 * @param endpoint - o endereço declarado no manifesto.
 * @returns `true` quando serve como destino.
 */
export function isAllowedEndpoint(endpoint: string): boolean {
  let url: URL
  try { url = new URL(endpoint) } catch { return false }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.hostname === '') return false
  return !hostBloqueado(hostCanonico(url.hostname))
}

/**
 * `new URL('http://[::1]/').hostname` keeps the brackets, so the bare form never matched.
 *
 * `*.localhost` é loopback aqui e NÃO é em `hostBloqueado`, e a diferença é de
 * propósito: esta função decide o PISO de política, onde reconhecer de menos
 * aperta; aquela decide o destino permitido, onde reconhecer de mais abre.
 */
export function isLoopbackHostname(host: string): boolean {
  const canonico = hostCanonico(host)
  return hostLoopback(canonico) || (canonico.forma === 'NOME' && canonico.texto.endsWith('.localhost'))
}

/** Whether a full URL points back at this very machine. Anything unparseable is NOT loopback (fail closed). */
export function isLoopbackEndpoint(endpoint: string): boolean {
  try { return isLoopbackHostname(new URL(endpoint).hostname) } catch { return false }
}

/** Whether a `Host:`-style authority (`127.0.0.1:3000`, `[::1]:3000`, `localhost`) points back at this machine. */
export function isLoopbackAuthority(authority: string): boolean {
  try { return isLoopbackHostname(new URL(`http://${authority}`).hostname) } catch { return false }
}

/** Most restrictive of the manifest's declared tier and the policy floor; missing/invalid declared tier → T2. */
export function effectiveTier(kind: IntegrationKind, manifest: IntegrationManifest): PolicyTier {
  const declared = (['T0', 'T1', 'T2', 'T3'] as const).includes(manifest.tier as PolicyTier) ? (manifest.tier as PolicyTier) : 'T2'
  return maxTier(declared, policyFloor(kind, manifest))
}

/**
 * Canonical form signed by the publisher: the manifest object exactly as
 * supplied (no defaults added, no trimming), without `signature`, keys sorted
 * by code point at every level, JSON without whitespace, UTF-8. A signer that
 * follows these five rules with any JSON library produces the same bytes.
 */
/**
 * Campos que o SCHEMA preenche quando o publicador não os escreveu, e que por
 * isso não podem entrar nos bytes assinados enquanto estiverem vazios.
 *
 * O arquivo de modelo já ensinava esta lição uma linha acima do defeito: o
 * `name` é declarado sem `.trim()` com a justificativa escrita de que "a
 * assinatura é conferida sobre o manifesto COMO ELE VEIO, e um schema que apara
 * em silêncio produz um registro cujos bytes não são os bytes assinados". E aí
 * `permissions` vinha com `.default([])`, que faz exatamente isso.
 *
 * O efeito era uma AUTORIDADE DIVIDIDA, que é o defeito mais caro deste
 * repositório: um v1 legítimo que omitisse `permissions` era gravado como
 * `verified` — e toda reconferência posterior, que lê o registro GRAVADO, via
 * `invalid`. A integração ficava ligada, marcada como verificada na tela, e
 * nunca executava. Falhava fechado, então não era brecha; era o produto
 * afirmando duas coisas diferentes sobre o mesmo documento, para sempre.
 *
 * Omitir uma lista VAZIA é canonicalização, não folga: `permissions: []` e
 * `permissions` ausente concedem exatamente a mesma coisa — nada.
 */
const OMISSOES_CANONICAS = ['permissions'] as const

export function canonicalManifestBytes(manifest: Readonly<Record<string, unknown>>): Buffer {
  const { signature: _signature, ...rest } = manifest
  const canonico: Record<string, unknown> = { ...rest }
  for (const campo of OMISSOES_CANONICAS) {
    const valor = canonico[campo]
    if (Array.isArray(valor) && valor.length === 0) delete canonico[campo]
  }
  return canonicalJsonBytes(canonico)
}

/** The same five rules, for anything that has to hash the same way twice (see `securityFingerprint`). */
export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(sortKeys(value)), 'utf8')
}

export function evaluateManifest(input: unknown, publisherKeys: PublisherKeys): ManifestEvaluation {
  const parsed = integrationManifestSchema.safeParse(input)
  if (!parsed.success) {
    // Field names only: Zod's English messages never reach the interface.
    const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join('.') || '$'))].slice(0, 5)
    return { manifest: null, verification: 'invalid', effectiveTier: UNVERIFIED_FLOOR, reasons: fields.map(field => t('manifest.reasonInvalidField', { field })) }
  }
  const manifest = parsed.data
  const declaredTier = effectiveTier(manifest.kind, manifest)
  // O ENDERECO e recusado ANTES da assinatura, e a ordem importa: assinar nao
  // torna um destino aceitavel. Um manifesto assinado apontando para
  // `169.254.169.254` — o servico de metadados de nuvem, que entrega credencial
  // da maquina para quem perguntar — chegava a `verified` e era entregue
  // inteiro ao despachante.
  //
  // O confronto entre `capabilities.network.egress` e o `endpoint` real — que
  // este comentario AFIRMAVA existir sem que existisse — mora em
  // `endpointForaDoEgress`, dentro de `capabilityIncoherences`, e por isso cai
  // na mesma recusa das outras contradicoes: assinado, porem `unverified`.
  if (manifest.endpoint !== undefined && !isAllowedEndpoint(manifest.endpoint)) {
    return { manifest, verification: 'invalid', effectiveTier: maxTier(declaredTier, UNVERIFIED_FLOOR), reasons: [t('manifest.reasonEndpointRefused')] }
  }
  const unverified = (reason: string | readonly string[], verification: 'unverified' | 'invalid'): ManifestEvaluation => {
    const tier = maxTier(declaredTier, UNVERIFIED_FLOOR)
    const reasons = [...(typeof reason === 'string' ? [reason] : reason)]
    if (tier !== manifest.tier) reasons.push(t('manifest.reasonUnverifiedTier', { tier, declared: manifest.tier ?? t('manifest.tierAbsent') }))
    return { manifest, verification, effectiveTier: tier, reasons }
  }
  if (manifest.signature === undefined) return unverified(t('manifest.reasonUnsigned'), 'unverified')
  // `publisherKeys['constructor']` would otherwise hand back `Object` and turn "no key" into "invalid".
  const publicKey = Object.hasOwn(publisherKeys, manifest.publisher.id) ? publisherKeys[manifest.publisher.id] : undefined
  if (publicKey === undefined) return unverified(t('manifest.reasonNoPublisherKey'), 'unverified')
  let valid = false
  try {
    const key = createPublicKey(publicKey.includes('BEGIN') ? publicKey : { key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
    valid = verify(null, canonicalManifestBytes(input as Record<string, unknown>), key, Buffer.from(manifest.signature, 'base64'))
  } catch { valid = false }
  if (!valid) return unverified(t('manifest.reasonSignatureInvalid'), 'invalid')
  // A assinatura só prova QUEM escreveu. Um documento assinado que se contradiz
  // não vira verdade por estar assinado: ele não chega a `verified`.
  const incoherences = capabilityIncoherences(manifest)
  if (incoherences.length > 0) return unverified([t('manifest.reasonIncoherentManifest'), ...incoherences], 'unverified')
  const reasons: string[] = []
  if (manifest.tier !== declaredTier) reasons.push(t('manifest.reasonTier', { tier: declaredTier, declared: manifest.tier ?? t('manifest.tierAbsent') }))
  return { manifest, verification: 'verified', effectiveTier: declaredTier, reasons }
}

export const manifestEvaluationSchema = z.object({
  verification: z.enum(['verified', 'unverified', 'invalid']),
  effective_tier: z.enum(['T0', 'T1', 'T2', 'T3']),
  reasons: z.array(z.string()),
}).strict()

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    // Code-point order, locale-independent: the same bytes on every machine.
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, sortKeys(v)]))
  }
  return value
}
