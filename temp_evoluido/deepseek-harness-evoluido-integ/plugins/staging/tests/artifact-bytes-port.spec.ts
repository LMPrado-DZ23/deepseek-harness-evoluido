import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { authorizedArtifactKey, runArtifactBytesPort } from '../src/plugin.js'
import type { StagingArtifact } from '../src/model.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const sha = (marker: string): string => marker.repeat(64).slice(0, 64)

function artifactOf(projectId: string, runId: string): StagingArtifact {
  return {
    project_id: projectId, run_id: runId, artifact_ref: `dz23-artifact:${runId}`,
    artifact_sha256: sha('a'), manifest_sha256: sha('b'), acceptance_sha256: sha('c'),
    sbom_sha256: sha('d'), provenance_sha256: sha('e'),
    builder_image_digest: `sha256:${sha('f')}`, policy_sha256: sha('9'),
  }
}

async function runDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dz23-staging-bytes-'))
  roots.push(root)
  await mkdir(resolve(root, 'evidence'), { recursive: true })
  await writeFile(
    resolve(root, 'evidence', 'attestation-manifest.json'),
    JSON.stringify({ artifact_sha256: sha('a'), files: [{ path: 'index.html', sha256: sha('1') }] }),
    'utf8',
  )
  return root
}

describe('ACHADO: a autorização de leitura leva PROJETO, e não só execução', () => {
  it('a chave separa projetos: um `run_id` repetido não abre o diretório alheio', async () => {
    // O mapa era indexado APENAS pelo `run_id`, e a separação por organização e
    // inquilino — feita com cuidado na leitura autorizada, logo antes — era
    // descartada na hora de guardar. Dois inquilinos com `run_id` coincidente
    // faziam a publicação de um ler os bytes do diretório do outro.
    const meu = await runDirectory()
    const autorizados = new Map([[authorizedArtifactKey('projeto-a', 'run-1'), meu]])
    const port = runArtifactBytesPort(key => autorizados.get(key))

    await expect(port.open(artifactOf('projeto-a', 'run-1'))).resolves.toMatchObject({ directory: meu })
    // Mesmo `run_id`, projeto diferente: não resolve.
    await expect(port.open(artifactOf('projeto-b', 'run-1'))).rejects.toThrow('ARTIFACT_RUN_MISSING')
  })

  it('a chave não pode ser forjada por concatenação', () => {
    // O separador é um byte nulo, que não aparece em identificador: sem ele,
    // `projeto-a` + `b-run-1` e `projeto-a-b` + `run-1` dariam a mesma chave, e
    // a separação entre projetos seria uma ilusão de string.
    expect(authorizedArtifactKey('a', 'b-c')).not.toBe(authorizedArtifactKey('a-b', 'c'))
    expect(authorizedArtifactKey('a', 'b')).toContain(String.fromCharCode(0))
  })

  it('uma autorização que não existe é recusada, e não procurada por conta própria', async () => {
    const port = runArtifactBytesPort(() => undefined)
    await expect(port.open(artifactOf('projeto-a', 'run-1'))).rejects.toThrow('ARTIFACT_RUN_MISSING')
  })
})
