import { describe, expect, it } from 'vitest'
import {
  StagingSourceError,
  artifactFromRun,
  artifactRef,
  selectVerifiedRun,
  verifiedRunSourcePort,
  type VerifiedRunView,
} from '../src/source.js'
import { owner } from './helpers.js'

const digest = (marker: string): string => marker.repeat(64).slice(0, 64)

const ATTESTATIONS = {
  acceptance_sha256: digest('1'), manifest_sha256: digest('2'), sbom_sha256: digest('3'),
  provenance_sha256: digest('4'), builder_image_digest: `sha256:${digest('5')}`, policy_sha256: digest('6'),
}

function run(overrides: Partial<VerifiedRunView> = {}): VerifiedRunView {
  return {
    run_id: 'run-1', project_id: 'project-1', org_id: owner.orgId, tenant_id: owner.tenantId,
    state: 'PASSED', artifact_sha256: digest('a'), template_integrity: 'VERIFIED',
    finished_at: '2026-09-08T12:00:00.000Z', attestations: ATTESTATIONS,
    ...overrides,
  }
}

describe('escolher a execução', () => {
  it('sem nome, a mais recente APROVADA', () => {
    const chosen = selectVerifiedRun([
      run({ run_id: 'antiga', finished_at: '2026-09-08T10:00:00.000Z' }),
      run({ run_id: 'recente', finished_at: '2026-09-08T12:00:00.000Z' }),
      // Uma falha posterior não apaga a que passou, e também não pode ser
      // escolhida por ser a última.
      run({ run_id: 'falhou', state: 'FAILED', finished_at: '2026-09-08T13:00:00.000Z' }),
    ], 'project-1', owner)
    expect(chosen.run_id).toBe('recente')
  })

  it('a execução nomeada que não existe NESTE escopo não vira outra', () => {
    // Publicar algo diferente do que a pessoa nomeou é o pior desfeito possível
    // numa operação com efeito fora do Studio.
    expect(() => selectVerifiedRun([run()], 'project-1', owner, 'outra')).toThrow(StagingSourceError)
    expect(() => selectVerifiedRun([run({ org_id: 'outra-org' })], 'project-1', owner, 'run-1')).toThrow(StagingSourceError)
    expect(() => selectVerifiedRun([run({ tenant_id: 'outro' })], 'project-1', owner, 'run-1')).toThrow(StagingSourceError)
  })

  it('a execução nomeada é respeitada mesmo não sendo a mais recente', () => {
    const chosen = selectVerifiedRun([
      run({ run_id: 'antiga', finished_at: '2026-09-08T10:00:00.000Z' }),
      run({ run_id: 'recente', finished_at: '2026-09-08T12:00:00.000Z' }),
    ], 'project-1', owner, 'antiga')
    expect(chosen.run_id).toBe('antiga')
  })

  it('projeto sem nenhuma execução aprovada recusa', () => {
    expect(() => selectVerifiedRun([run({ state: 'FAILED' })], 'project-1', owner))
      .toThrow(/nenhuma execução verificada/u)
    expect(() => selectVerifiedRun([], 'project-1', owner)).toThrow(StagingSourceError)
    expect(() => selectVerifiedRun([run()], 'outro-projeto', owner)).toThrow(StagingSourceError)
  })
})

describe('selar o artefato', () => {
  it('uma execução aprovada com atestações vira artefato selado', () => {
    const artifact = artifactFromRun(run())
    expect(artifact).toEqual({
      project_id: 'project-1', run_id: 'run-1',
      artifact_ref: `dz23-artifact:sha256-${digest('a')}`, artifact_sha256: digest('a'),
      manifest_sha256: ATTESTATIONS.manifest_sha256, acceptance_sha256: ATTESTATIONS.acceptance_sha256,
      sbom_sha256: ATTESTATIONS.sbom_sha256, provenance_sha256: ATTESTATIONS.provenance_sha256,
      builder_image_digest: ATTESTATIONS.builder_image_digest, policy_sha256: ATTESTATIONS.policy_sha256,
    })
  })

  it('a referência identifica o CONTEÚDO, e não um caminho no computador', () => {
    // Um caminho absoluto mudaria entre instalações do mesmo artefato, e não é
    // assunto do provedor de staging.
    expect(artifactRef(digest('a'))).toBe(`dz23-artifact:sha256-${digest('a')}`)
    expect(artifactRef(digest('a'))).not.toMatch(/\/home\/|[A-Za-z]:\\/u)
  })

  it('cada recusa tem seu próprio código, porque pedem gestos diferentes', () => {
    const cases = [
      [run({ state: 'FAILED' }), 'RUN_NOT_VERIFIED'],
      [run({ artifact_sha256: null }), 'ARTIFACT_MISSING'],
      [run({ template_integrity: 'FAILED' }), 'TEMPLATE_INTEGRITY_FAILED'],
      // Registro antigo, gravado antes de o campo existir: ausente NÃO é
      // "conferido".
      [run({ template_integrity: undefined }), 'TEMPLATE_INTEGRITY_FAILED'],
      [run({ attestations: undefined }), 'ATTESTATIONS_MISSING'],
    ] as const
    for (const [candidate, code] of cases) {
      const error = (() => { try { artifactFromRun(candidate); return undefined } catch (caught) { return caught } })()
      expect(error, code).toBeInstanceOf(StagingSourceError)
      expect((error as StagingSourceError).code, code).toBe(code)
    }
  })

  it('atestação com hash malformado é recusada pelo esquema do staging', () => {
    expect(() => artifactFromRun(run({
      attestations: { ...ATTESTATIONS, sbom_sha256: 'curto' },
    }))).toThrow()
    expect(() => artifactFromRun(run({
      attestations: { ...ATTESTATIONS, builder_image_digest: 'sem-prefixo' },
    }))).toThrow()
  })
})

describe('a porta de origem', () => {
  it('lê do runtime de execuções e devolve o artefato selado', async () => {
    const port = verifiedRunSourcePort({ runs: () => [run()] })
    await expect(port.verifiedArtifact(owner, 'project-1')).resolves.toMatchObject({ run_id: 'run-1' })
  })

  it('não atravessa o inquilino', async () => {
    const port = verifiedRunSourcePort({ runs: () => [run({ tenant_id: 'outro' })] })
    await expect(port.verifiedArtifact(owner, 'project-1')).rejects.toBeInstanceOf(StagingSourceError)
  })
})
