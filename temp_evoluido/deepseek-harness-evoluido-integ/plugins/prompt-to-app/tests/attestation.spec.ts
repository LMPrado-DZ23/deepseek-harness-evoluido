import { describe, expect, it } from 'vitest'
import {
  acceptanceAttestation,
  canonicalDocument,
  documentSha256,
  manifestAttestation,
  provenanceAttestation,
  sbomAttestation,
  type AttestationCheck,
} from '../src/attestation.ts'

const builder = {
  image_digest: `sha256:${'a'.repeat(64)}`,
  policy_sha256: 'b'.repeat(64),
  scope_id: 'scope-1',
}
const AT = '2026-09-08T12:00:00.000Z'
const ARTIFACT = 'c'.repeat(64)

function checks(...statuses: AttestationCheck['status'][]): readonly AttestationCheck[] {
  return statuses.map((status, index) => ({ id: `check-${String(index)}`, kind: 'criterion', status }))
}

function acceptance(overrides: Partial<Parameters<typeof acceptanceAttestation>[0]> = {}) {
  return acceptanceAttestation({
    runId: 'run-1', projectId: 'projeto-1', artifactSha256: ARTIFACT,
    templateIntegrity: 'VERIFIED', builder, checks: checks('PASSED', 'PASSED'),
    lifecyclePassed: true, attestedAt: AT, ...overrides,
  })
}

describe('texto canônico e resumo', () => {
  it('a ordem em que os campos foram escritos não muda o resumo', () => {
    // Sem isto, reordenar uma linha do código mudaria o sha256 de uma
    // atestação já emitida.
    expect(documentSha256({ b: 1, a: 2 })).toBe(documentSha256({ a: 2, b: 1 }))
    expect(canonicalDocument({ b: [{ z: 1, y: 2 }], a: null })).toBe('{"a":null,"b":[{"y":2,"z":1}]}')
  })

  it('mudar qualquer campo muda o resumo', () => {
    expect(acceptance().sha256).not.toBe(acceptance({ artifactSha256: 'd'.repeat(64) }).sha256)
    expect(acceptance().sha256).not.toBe(acceptance({ attestedAt: '2026-09-09T12:00:00.000Z' }).sha256)
  })

  it('a ordem de uma LISTA é conteúdo, e não é reordenada', () => {
    expect(canonicalDocument([1, 2])).not.toBe(canonicalDocument([2, 1]))
  })
})

describe('atestação de aceitação', () => {
  it('aprova só quando TUDO está no lugar', () => {
    const { document } = acceptance()
    expect(document.verdict).toBe('PASSED')
    expect(document.summary).toEqual({ total: 2, passed: 2, failed: 0, not_automated: 0, pending: 0 })
  })

  it('qualquer buraco reprova, um de cada vez', () => {
    // Uma atestação que não olha evidência é pior que atestação nenhuma:
    // ela AUTORIZA.
    expect(acceptance({ checks: checks('PASSED', 'FAILED') }).document.verdict).toBe('FAILED')
    expect(acceptance({ checks: checks('PASSED', 'PENDING') }).document.verdict).toBe('FAILED')
    expect(acceptance({ lifecyclePassed: false }).document.verdict).toBe('FAILED')
    expect(acceptance({ templateIntegrity: 'FAILED' }).document.verdict).toBe('FAILED')
  })

  it('critério NÃO AUTOMATIZADO não reprova, e continua visível', () => {
    // Ele diz "isto ninguém conferiu por máquina" - esconder seria pior, e
    // reprovar por causa dele tornaria o veredito inalcançável.
    const { document } = acceptance({ checks: checks('PASSED', 'NOT_AUTOMATED') })
    expect(document.verdict).toBe('PASSED')
    expect(document.summary.not_automated).toBe(1)
  })

  it('nenhum critério NÃO é aprovação: é ausência de conferência', () => {
    const { document } = acceptance({ checks: [] })
    expect(document.verdict).toBe('FAILED')
    expect(document.summary.total).toBe(0)
  })

  it('os critérios saem em ordem de id, para dois documentos serem comparáveis', () => {
    const { document } = acceptance({
      checks: [
        { id: 'z', kind: 'criterion', status: 'PASSED' },
        { id: 'a', kind: 'criterion', status: 'PASSED' },
      ],
    })
    expect(document.checks.map(check => check.id)).toEqual(['a', 'z'])
  })

  it('a imagem e a política do construtor viajam dentro da atestação', () => {
    // Sem elas, a atestação não diz COM O QUÊ o artefato foi construído, e
    // duas construções sob políticas diferentes ficariam indistinguíveis.
    expect(acceptance().document.builder).toEqual(builder)
  })
})

describe('manifesto', () => {
  it('os arquivos saem em ordem de caminho, com contagem e tamanho', () => {
    const { document } = manifestAttestation({
      runId: 'run-1', artifactSha256: ARTIFACT, attestedAt: AT,
      files: [
        { path: 'src/b.ts', sha256: 'b'.repeat(64), bytes: 20 },
        { path: 'src/a.ts', sha256: 'a'.repeat(64), bytes: 10 },
      ],
    })
    expect(document.files.map(file => file.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect({ count: document.file_count, bytes: document.total_bytes }).toEqual({ count: 2, bytes: 30 })
  })

  it('a ordem de leitura do disco não muda o resumo do manifesto', () => {
    // Um manifesto que mudasse de hash conforme o sistema que o leu não
    // serviria para comparar duas construções.
    const files = [
      { path: 'a', sha256: 'a'.repeat(64), bytes: 1 },
      { path: 'b', sha256: 'b'.repeat(64), bytes: 2 },
    ]
    const first = manifestAttestation({ runId: 'r', artifactSha256: ARTIFACT, files, attestedAt: AT })
    const second = manifestAttestation({ runId: 'r', artifactSha256: ARTIFACT, files: [...files].reverse(), attestedAt: AT })
    expect(first.sha256).toBe(second.sha256)
  })

  it('um arquivo a mais muda o resumo', () => {
    const base = [{ path: 'a', sha256: 'a'.repeat(64), bytes: 1 }]
    const first = manifestAttestation({ runId: 'r', artifactSha256: ARTIFACT, files: base, attestedAt: AT })
    const second = manifestAttestation({
      runId: 'r', artifactSha256: ARTIFACT, attestedAt: AT,
      files: [...base, { path: 'b', sha256: 'b'.repeat(64), bytes: 1 }],
    })
    expect(first.sha256).not.toBe(second.sha256)
  })
})

describe('SBOM', () => {
  it('lista o que o app DECLARA, dizendo que é declaração e não árvore instalada', () => {
    const { document } = sbomAttestation({
      runId: 'run-1', artifactSha256: ARTIFACT, attestedAt: AT,
      packageJson: { dependencies: { react: '^19.0.0' }, devDependencies: { vitest: '4.1.8' } },
    })
    expect(document.source).toBe('declared')
    expect(document.components).toEqual([
      { name: 'react', version: '^19.0.0', scope: 'runtime' },
      { name: 'vitest', version: '4.1.8', scope: 'development' },
    ])
  })

  it('sem package.json legível a lista é vazia COM MOTIVO, e não "não depende de nada"', () => {
    for (const broken of [undefined, null, 'texto', [], 7]) {
      const { document } = sbomAttestation({ runId: 'r', artifactSha256: ARTIFACT, packageJson: broken, attestedAt: AT })
      expect(document.source, JSON.stringify(broken)).toBe('unavailable')
      expect(document.unavailable_reason).toBe('PACKAGE_JSON_UNREADABLE')
      expect(document.components).toEqual([])
    }
  })

  it('um package.json sem dependências é "declarado com zero", e não "indisponível"', () => {
    // As duas coisas são diferentes: uma é uma resposta, a outra é a falta dela.
    const { document } = sbomAttestation({ runId: 'r', artifactSha256: ARTIFACT, packageJson: { name: 'app' }, attestedAt: AT })
    expect({ source: document.source, reason: document.unavailable_reason, total: document.components.length })
      .toEqual({ source: 'declared', reason: null, total: 0 })
  })

  it('versão que não é texto é descartada em vez de virar "undefined"', () => {
    const { document } = sbomAttestation({
      runId: 'r', artifactSha256: ARTIFACT, attestedAt: AT,
      packageJson: { dependencies: { boa: '1.0.0', ruim: { version: '2' } } },
    })
    expect(document.components).toEqual([{ name: 'boa', version: '1.0.0', scope: 'runtime' }])
  })

  it('as dependências saem em ordem, para dois SBOMs serem comparáveis', () => {
    const { document } = sbomAttestation({
      runId: 'r', artifactSha256: ARTIFACT, attestedAt: AT,
      packageJson: { dependencies: { zod: '4', axios: '1' } },
    })
    expect(document.components.map(component => component.name)).toEqual(['axios', 'zod'])
  })
})

describe('proveniência', () => {
  const provenance = provenanceAttestation({
    runId: 'run-1', projectId: 'projeto-1', planId: 'plano-1', artifactSha256: ARTIFACT,
    manifestSha256: 'd'.repeat(64), builder, appSpecSha256: 'e'.repeat(64),
    templateId: 'landing-page', templateVersion: '1.0.0', templateIntegrity: 'VERIFIED',
    attempt: 1, attestedAt: AT,
  })

  it('diz de onde o artefato veio: espec, template, imagem e política', () => {
    expect(provenance.document.inputs).toEqual({
      app_spec_sha256: 'e'.repeat(64), template_id: 'landing-page',
      template_version: '1.0.0', template_integrity: 'VERIFIED',
    })
    expect(provenance.document.builder).toEqual(builder)
    expect(provenance.document.manifest_sha256).toBe('d'.repeat(64))
  })

  it('declara que NÃO é assinada, com todas as letras', () => {
    // Hash não é assinatura. Um documento que se calasse sobre isso seria lido
    // como prova de origem, que ele não é.
    expect(provenance.document.signed).toBe(false)
    expect(provenance.document.signature_note).toContain('HASH_NAO_E_ASSINATURA')
  })

  it('registra que a construção foi sem rede e com lockfile congelado', () => {
    expect(provenance.document.build).toEqual({ offline: true, frozen_lockfile: true, attempt: 1 })
  })
})
