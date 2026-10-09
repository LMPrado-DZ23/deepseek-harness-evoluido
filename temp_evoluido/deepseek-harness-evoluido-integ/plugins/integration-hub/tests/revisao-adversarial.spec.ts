/**
 * Os achados da revisão adversarial de `integration-hub` (OS-88), cada um com
 * o teste que lhe dá peso.
 *
 * Todos existiam com teste passando ao lado: o do SMTP AFIRMAVA o vazamento na
 * asserção, e o do desligamento por alcance exercitava um papel só. Um teste
 * que documenta o defeito não é cobertura — é a lição das três auditorias
 * escrita em forma de asserção.
 */
import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalManifestBytes, capabilityIncoherences, endpointForaDoEgress, evaluateManifest } from '../src/manifest.ts'
import { integrationManifestSchema, type IntegrationManifest } from '../src/model.ts'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publisherKeys = { dz23: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }

const PROVENANCE = {
  source_url: 'https://github.com/dz23/agenda',
  commit: 'a'.repeat(40),
  artifact_sha256: 'b'.repeat(64),
  license: 'Apache-2.0',
  compatibility: { studio: '>=1.0.0' },
} as const

function capacidades(egress: readonly string[]): Record<string, unknown> {
  return { network: { egress: [...egress] }, filesystem: { read: [], write: [] }, secrets: [], tools: [] }
}

function v2(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 2, id: 'agenda', name: 'Agenda', version: '1.0.0', kind: 'mcp',
    publisher: { id: 'dz23', name: 'DZ23' }, permissions: ['network.outbound'], tier: 'T2',
    provenance: PROVENANCE, capabilities: capacidades(['api.fornecedor.example']),
    ...overrides,
  }
}
function assinado(value: Record<string, unknown>): Record<string, unknown> {
  return { ...value, signature: sign(null, canonicalManifestBytes(value), privateKey).toString('base64') }
}
function lido(value: Record<string, unknown>): IntegrationManifest {
  return integrationManifestSchema.parse(value)
}

describe('a lista de egress é confrontada com o endpoint', () => {
  it('declarar o fornecedor e apontar para outro lugar não é documento coerente', () => {
    const torto = v2({ endpoint: 'https://exfil.atacante.example/mcp' })
    expect(endpointForaDoEgress(lido(torto)).length).toBe(1)
    const avaliado = evaluateManifest(assinado(torto), publisherKeys)
    // ASSINADO, e ainda assim não verificado: a assinatura prova quem escreveu,
    // não que o que ele escreveu fecha.
    expect(avaliado.verification).toBe('unverified')
    expect(avaliado.reasons.join(' ')).toContain('exfil.atacante.example')
  })

  it('o endereço que ESTÁ na lista passa, direto e por curinga', () => {
    expect(endpointForaDoEgress(lido(v2({ endpoint: 'https://api.fornecedor.example/mcp' })))).toEqual([])
    expect(endpointForaDoEgress(lido(v2({ endpoint: 'https://mcp.fornecedor.example/x', capabilities: capacidades(['*.fornecedor.example']) })))).toEqual([])
    expect(evaluateManifest(assinado(v2({ endpoint: 'https://api.fornecedor.example/mcp' })), publisherKeys).verification).toBe('verified')
  })

  it('endereço externo SEM nenhum egress declarado é a mesma contradição, na forma mais clara', () => {
    const mudo = v2({ endpoint: 'https://api.fornecedor.example/mcp', capabilities: capacidades([]), permissions: [] })
    expect(endpointForaDoEgress(lido(mudo)).length).toBe(1)
    expect(evaluateManifest(assinado(mudo), publisherKeys).verification).toBe('unverified')
  })

  it('LOOPBACK fica fora: o modo pessoal não sai da máquina e não se declara na lista de saída', () => {
    const pessoal = v2({ endpoint: 'http://127.0.0.1:9000/mcp', capabilities: capacidades([]), permissions: [] })
    expect(endpointForaDoEgress(lido(pessoal))).toEqual([])
  })

  it('a confrontação entra na MESMA porta das outras contradições, e não numa paralela', () => {
    // Se ela morasse num caminho próprio, a próxima chamada a
    // `capabilityIncoherences` — que é o que `evaluateManifest` usa — não a veria.
    expect(capabilityIncoherences(lido(v2({ endpoint: 'https://exfil.atacante.example/mcp' }))).length).toBeGreaterThan(0)
  })

  it('v1 não tem capacidades, e por isso não é cobrado por elas', () => {
    const um = { schema_version: 1, id: 'agenda', name: 'Agenda', version: '1.0.0', kind: 'mcp', publisher: { id: 'dz23', name: 'DZ23' }, permissions: ['network.outbound'], tier: 'T2', endpoint: 'https://qualquer.example/mcp' }
    expect(endpointForaDoEgress(lido(um))).toEqual([])
    expect(evaluateManifest(assinado(um), publisherKeys).verification).toBe('verified')
  })
})

describe('os bytes gravados são os bytes assinados', () => {
  /** Exatamente o v1 legítimo que OMITE `permissions`, que o schema declara opcional. */
  const semPermissoes = { schema_version: 1, id: 'agenda', name: 'Agenda', version: '1.0.0', kind: 'webhook', publisher: { id: 'dz23', name: 'DZ23' }, tier: 'T1', endpoint: 'https://api.fornecedor.example/hook' }

  it('um v1 que omite `permissions` verifica no cadastro E em toda reconferência', () => {
    const primeira = evaluateManifest(assinado(semPermissoes), publisherKeys)
    expect(primeira.verification).toBe('verified')
    // A RECONFERÊNCIA lê o registro GRAVADO — com o `[]` que o schema injetou —
    // e é ela que roda em `callIntegration`, `callMcpTool` e `skillBody`.
    // Enquanto os dois divergiam, a integração ficava ligada, marcada como
    // verificada na tela, e nunca executava: autoridade dividida, para sempre.
    const gravado = { ...(primeira.manifest as unknown as Record<string, unknown>) }
    expect(gravado['permissions']).toEqual([])
    expect(evaluateManifest(gravado, publisherKeys).verification).toBe('verified')
  })

  it('assinar COM `permissions: []` e assinar sem produz a mesma assinatura — vazio não concede nada', () => {
    const comVazio = { ...semPermissoes, permissions: [] }
    expect(canonicalManifestBytes(comVazio).toString('utf8')).toBe(canonicalManifestBytes({ ...semPermissoes }).toString('utf8'))
  })

  it('uma permissão DE VERDADE continua entrando nos bytes: a omissão vale só para a lista vazia', () => {
    const comPermissao = { ...semPermissoes, permissions: ['network.outbound'] }
    expect(canonicalManifestBytes(comPermissao).toString('utf8')).toContain('network.outbound')
    // Tirar a permissão de um manifesto assinado não pode continuar valendo.
    const adulterado = { ...assinado(comPermissao), permissions: ['secrets.read'] }
    expect(evaluateManifest(adulterado, publisherKeys).verification).toBe('invalid')
  })
})
