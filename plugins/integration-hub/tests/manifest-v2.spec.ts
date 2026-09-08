/**
 * X-02 — manifesto v2: origem, commit/hash, licença, compatibilidade, e o que
 * a integração diz que toca (rede, filesystem, segredos, ferramentas).
 *
 * O que estes testes protegem, em ordem de importância:
 *
 * 1. um manifesto v1 JÁ ASSINADO continua verificando exatamente como antes.
 *    Trocar v1 por v2 invalidaria toda assinatura já emitida, e uma migração
 *    forçada é a forma mais rápida de fazer alguém desligar a verificação para
 *    voltar a trabalhar;
 * 2. o que o v2 declara não é enfeite: uma capacidade declarada levanta o piso
 *    sozinha, e um documento assinado que se contradiz NÃO chega a `verified`;
 * 3. o manifesto continua sendo um documento público — nenhum valor de segredo
 *    cabe nele, só referência.
 */
import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalManifestBytes, capabilityFloor, capabilityIncoherences, CAPABILITY_RULES, effectiveTier, evaluateManifest, policyFloor } from '../src/manifest.ts'
import { declaresProvenance, integrationManifestSchema, integrationPermissionSchema, type IntegrationManifest } from '../src/model.ts'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publisherKeys = { dz23: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }

const PROVENANCE = {
  source_url: 'https://github.com/dz23/agenda',
  commit: 'a'.repeat(40),
  artifact_sha256: 'b'.repeat(64),
  license: 'Apache-2.0',
  compatibility: { studio: '>=1.0.0' },
} as const

const EMPTY_CAPABILITIES = { network: { egress: [] }, filesystem: { read: [], write: [] }, secrets: [], tools: [] } as const

function v2(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 2, id: 'agenda', name: 'Agenda', version: '1.0.0', kind: 'skill',
    publisher: { id: 'dz23', name: 'DZ23' }, permissions: [], tier: 'T0',
    provenance: PROVENANCE, capabilities: EMPTY_CAPABILITIES,
    ...overrides,
  }
}
function signedOf(value: Record<string, unknown>): Record<string, unknown> {
  return { ...value, signature: sign(null, canonicalManifestBytes(value), privateKey).toString('base64') }
}
function parsed(value: Record<string, unknown>): IntegrationManifest {
  return integrationManifestSchema.parse(value)
}

describe('X-02 manifesto v2 — compatibilidade com v1', () => {
  it('um v1 já assinado continua verificando, e continua sendo v1', () => {
    const one = { schema_version: 1, id: 'agenda', name: 'Agenda', version: '1.0.0', kind: 'skill', publisher: { id: 'dz23', name: 'DZ23' }, permissions: [], tier: 'T0' }
    const evaluation = evaluateManifest(signedOf(one), publisherKeys)
    expect(evaluation.verification).toBe('verified')
    expect(evaluation.effectiveTier).toBe('T0')
    expect(declaresProvenance(evaluation.manifest)).toBe(false)
  })

  it('v1 NÃO aceita os campos de v2: o schema é discriminado, não um saco de campos opcionais', () => {
    // Sem a união discriminada, mandar `provenance` num v1 passaria calado e o
    // registro guardaria uma origem que a assinatura v1 nunca cobriu.
    const smuggled = { schema_version: 1, id: 'agenda', name: 'Agenda', version: '1.0.0', kind: 'skill', publisher: { id: 'dz23', name: 'DZ23' }, permissions: [], tier: 'T0', provenance: PROVENANCE }
    expect(integrationManifestSchema.safeParse(smuggled).success).toBe(false)
    expect(evaluateManifest(smuggled, publisherKeys).verification).toBe('invalid')
  })

  it('v2 exige origem E capacidades: metade do documento não é um documento', () => {
    const { provenance: _p, ...noProvenance } = v2()
    const { capabilities: _c, ...noCapabilities } = v2()
    expect(integrationManifestSchema.safeParse(noProvenance).success).toBe(false)
    expect(integrationManifestSchema.safeParse(noCapabilities).success).toBe(false)
  })
})

describe('X-02 manifesto v2 — origem', () => {
  it('recusa origem que não seja http(s): um `file:` seria o disco de quem hospeda', () => {
    for (const source_url of ['file:///etc/passwd', 'ftp://x.example/a', 'javascript:alert(1)']) {
      expect(integrationManifestSchema.safeParse(v2({ provenance: { ...PROVENANCE, source_url } })).success).toBe(false)
    }
  })

  it('aceita `commit: null` (origem não versionada) e recusa commit encurtado ou inventado', () => {
    expect(integrationManifestSchema.safeParse(v2({ provenance: { ...PROVENANCE, commit: null } })).success).toBe(true)
    for (const commit of ['a'.repeat(7), 'A'.repeat(40), 'z'.repeat(40), '']) {
      expect(integrationManifestSchema.safeParse(v2({ provenance: { ...PROVENANCE, commit } })).success).toBe(false)
    }
  })

  it('exige sha256 do artefato: é o hash que liga o manifesto a bytes', () => {
    for (const artifact_sha256 of ['b'.repeat(63), 'b'.repeat(65), 'B'.repeat(64), 'nao-e-um-hash']) {
      expect(integrationManifestSchema.safeParse(v2({ provenance: { ...PROVENANCE, artifact_sha256 } })).success).toBe(false)
    }
  })

  it('a licença é um identificador, não texto livre: "grátis" não é licença', () => {
    for (const license of ['MIT', 'Apache-2.0', 'BSL-1.1', 'LicenseRef-DZ23']) {
      expect(integrationManifestSchema.safeParse(v2({ provenance: { ...PROVENANCE, license } })).success).toBe(true)
    }
    for (const license of ['grátis para uso interno', '', 'a'.repeat(65), 'MIT ou Apache']) {
      expect(integrationManifestSchema.safeParse(v2({ provenance: { ...PROVENANCE, license } })).success).toBe(false)
    }
  })

  it('não aceita campo desconhecido dentro da origem', () => {
    expect(integrationManifestSchema.safeParse(v2({ provenance: { ...PROVENANCE, mirror: 'https://x.example' } })).success).toBe(false)
  })
})

describe('X-02 manifesto v2 — o que ela diz que toca', () => {
  it('recusa `*` sozinho no egress: declarar a internet inteira é não declarar nada', () => {
    const wildcard = v2({ capabilities: { ...EMPTY_CAPABILITIES, network: { egress: ['*'] } } })
    expect(integrationManifestSchema.safeParse(wildcard).success).toBe(false)
    // Um subdomínio curinga continua sendo uma lista legível por quem decide.
    expect(integrationManifestSchema.safeParse(v2({ capabilities: { ...EMPTY_CAPABILITIES, network: { egress: ['*.example.com'] } } })).success).toBe(true)
  })

  it('caminhos de filesystem são relativos: um caminho absoluto seria o disco de quem hospeda', () => {
    for (const path of ['/etc/passwd', '/']) {
      expect(integrationManifestSchema.safeParse(v2({ capabilities: { ...EMPTY_CAPABILITIES, filesystem: { read: [path], write: [] } } })).success).toBe(false)
      expect(integrationManifestSchema.safeParse(v2({ capabilities: { ...EMPTY_CAPABILITIES, filesystem: { read: [], write: [path] } } })).success).toBe(false)
    }
    expect(integrationManifestSchema.safeParse(v2({ capabilities: { ...EMPTY_CAPABILITIES, filesystem: { read: ['dados/'], write: ['saida/relatorio.csv'] } } })).success).toBe(true)
  })

  it('segredos entram por REFERÊNCIA: um manifesto é público e assinado', () => {
    const byReference = v2({ permissions: ['secrets.read'], capabilities: { ...EMPTY_CAPABILITIES, secrets: ['SMTP_SENHA'] } })
    expect(integrationManifestSchema.safeParse(byReference).success).toBe(true)
    // Nada que pareça um valor passa pelo formato de referência do cofre.
    for (const secret of ['senha-em-texto-puro!', 'sk-ABCDEF0123456789', '']) {
      expect(integrationManifestSchema.safeParse(v2({ capabilities: { ...EMPTY_CAPABILITIES, secrets: [secret] } })).success).toBe(false)
    }
  })
})

describe('X-02 manifesto v2 — declarar tem consequência', () => {
  it('toda regra de capacidade aponta para uma permissão que existe de verdade', () => {
    // Uma regra que citasse uma permissão inexistente nunca fecharia, e a
    // incoerência resultante culparia o manifesto por um erro nosso.
    for (const rule of CAPABILITY_RULES) expect(integrationPermissionSchema.options).toContain(rule.permission)
  })

  it('a capacidade declarada levanta o piso SOZINHA, mesmo sem a permissão correspondente', () => {
    const network = parsed(v2({ capabilities: { ...EMPTY_CAPABILITIES, network: { egress: ['api.example.com'] } } }))
    expect(capabilityFloor(network)).toBe('T2')
    expect(policyFloor('skill', network)).toBe('T2')
    // E o `tier: T0` declarado não compra T0 de volta.
    expect(effectiveTier('skill', network)).toBe('T2')

    const secrets = parsed(v2({ capabilities: { ...EMPTY_CAPABILITIES, secrets: ['SMTP_SENHA'] } }))
    expect(capabilityFloor(secrets)).toBe('T3')
    expect(effectiveTier('skill', secrets)).toBe('T3')

    const write = parsed(v2({ capabilities: { ...EMPTY_CAPABILITIES, filesystem: { read: [], write: ['saida/'] } } }))
    expect(capabilityFloor(write)).toBe('T2')
  })

  it('um v2 que não declara nada tem piso T0, como um v1 equivalente', () => {
    expect(capabilityFloor(parsed(v2()))).toBe('T0')
    expect(policyFloor('skill', parsed(v2()))).toBe('T0')
  })

  it('capabilityFloor não se aplica a v1: v1 não declara capacidade nenhuma', () => {
    const one = parsed({ schema_version: 1, id: 'agenda', name: 'Agenda', version: '1.0.0', kind: 'skill', publisher: { id: 'dz23', name: 'DZ23' }, permissions: ['network.outbound'], tier: 'T0' })
    expect(capabilityFloor(one)).toBe('T0')
    expect(capabilityIncoherences(one)).toEqual([])
  })
})

describe('X-02 manifesto v2 — assinado não é o mesmo que coerente', () => {
  it('declara egress mas não pede a permissão: assinado, e ainda assim não verificado', () => {
    const evaluation = evaluateManifest(signedOf(v2({ capabilities: { ...EMPTY_CAPABILITIES, network: { egress: ['api.example.com'] } } })), publisherKeys)
    expect(evaluation.verification).toBe('unverified')
    // O piso não cai: quem lê a tela vê T2 e o motivo escrito.
    expect(evaluation.effectiveTier).toBe('T2')
    expect(evaluation.reasons.some(reason => reason.includes('network.egress') && reason.includes('network.outbound'))).toBe(true)
  })

  it('pede a permissão mas não nomeia ninguém: também não verifica', () => {
    const evaluation = evaluateManifest(signedOf(v2({ permissions: ['network.outbound'] })), publisherKeys)
    expect(evaluation.verification).toBe('unverified')
    expect(evaluation.reasons.some(reason => reason.includes('network.outbound'))).toBe(true)
  })

  it('quando fecha dos dois lados, verifica normalmente', () => {
    const coherent = v2({
      tier: 'T2',
      permissions: ['network.outbound'],
      capabilities: { ...EMPTY_CAPABILITIES, network: { egress: ['api.example.com'] }, tools: ['agenda.criar'] },
    })
    const evaluation = evaluateManifest(signedOf(coherent), publisherKeys)
    expect(evaluation.verification).toBe('verified')
    expect(evaluation.effectiveTier).toBe('T2')
    expect(declaresProvenance(evaluation.manifest)).toBe(true)
  })

  it('a incoerência é verificada DEPOIS da assinatura: um v2 incoerente e adulterado continua `invalid`', () => {
    // Se a ordem fosse a inversa, um manifesto adulterado sairia como
    // "incoerente" e alguém acharia que era só o publicador ter escrito errado.
    const signed = signedOf(v2({ capabilities: { ...EMPTY_CAPABILITIES, network: { egress: ['api.example.com'] } } }))
    const tampered = { ...signed, name: 'Agenda (adulterada)' }
    expect(evaluateManifest(tampered, publisherKeys).verification).toBe('invalid')
  })

  it('todas as incoerências aparecem juntas: consertar uma de cada vez é um documento por rodada', () => {
    const messy = parsed(v2({ permissions: ['secrets.read'], capabilities: { ...EMPTY_CAPABILITIES, network: { egress: ['api.example.com'] }, filesystem: { read: [], write: ['saida/'] } } }))
    const reasons = capabilityIncoherences(messy)
    // egress sem permissão, write sem permissão, e secrets.read sem segredo nomeado.
    expect(reasons).toHaveLength(3)
  })

  it('a assinatura cobre origem e capacidades: mexer nelas invalida', () => {
    const signed = signedOf(v2({ permissions: ['network.outbound'], capabilities: { ...EMPTY_CAPABILITIES, network: { egress: ['api.example.com'] } } }))
    expect(evaluateManifest(signed, publisherKeys).verification).toBe('verified')
    for (const tampered of [
      { ...signed, provenance: { ...PROVENANCE, source_url: 'https://outro.example/agenda' } },
      { ...signed, provenance: { ...PROVENANCE, artifact_sha256: 'c'.repeat(64) } },
      { ...signed, provenance: { ...PROVENANCE, license: 'MIT' } },
      { ...signed, capabilities: { ...EMPTY_CAPABILITIES, network: { egress: ['api.example.com', 'exfil.example.com'] } } },
    ]) {
      expect(evaluateManifest(tampered, publisherKeys).verification).toBe('invalid')
    }
  })
})
