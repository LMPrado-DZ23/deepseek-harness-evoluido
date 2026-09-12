import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createVerifiedBuildArchive } from '../src/artifact.js'
import { ArtifactIngressError } from '../src/artifact-ingress.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function tree(files: Record<string, string>): Promise<{ root: string; relative: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dz23-artifact-order-'))
  roots.push(root)
  const relative = 'run'
  for (const [path, content] of Object.entries(files)) {
    const full = resolve(root, relative, path)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, content, 'utf8')
  }
  return { root, relative }
}

/**
 * Lê os caminhos do tar exatamente como o validador de ingestão os vê: em
 * ordem, um cabeçalho USTAR a cada 512 bytes.
 */
function tarPaths(archive: Buffer): readonly string[] {
  const paths: string[] = []
  for (let offset = 0; offset + 512 <= archive.byteLength;) {
    const header = archive.subarray(offset, offset + 512)
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/su, '')
    if (name === '') break
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/su, '')
    const size = Number.parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/su, '').trim() || '0', 8)
    paths.push(prefix === '' ? name : `${prefix}/${name}`)
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return paths
}

describe('ACHADO: quem PRODUZ o artefato ordena como quem o VALIDA', () => {
  it('maiúscula e minúscula no mesmo diretório saem na ordem que a ingestão exige', async () => {
    // `walk` ordenava com `localeCompare`, que é ordem de IDIOMA: `a.js` vem
    // antes de `B.js`. O validador exige ordem estritamente crescente em
    // unidades UTF-16, e ali `B.js` (0x42) vem antes de `a.js` (0x61) — então
    // ele recusava com `ARTIFACT_INVALID` um artefato perfeitamente legítimo.
    //
    // Falha FECHADA, e por isso não é brecha. Mas é o caminho de ingestão
    // inteiro recusando artefato legítimo com um erro que aponta para
    // "artefato malicioso" — quem visse isso iria procurar um ataque que não
    // existe.
    const { root, relative } = await tree({ 'a.js': 'um', 'B.js': 'dois' })
    const built = await createVerifiedBuildArchive(root, relative)
    const arquivos = tarPaths(await readFile(built.archivePath)).filter(path => !path.endsWith('/'))
    await built.dispose()
    expect(arquivos).toEqual([...arquivos].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)))
    expect(arquivos).toEqual(['B.js', 'a.js'])
  })

  it('um diretório irmão de um arquivo com o mesmo prefixo também sai em ordem', async () => {
    // O outro caso, e ele não se resolve ordenando por diretório: a caminhada
    // emitia `a/x` antes de `a.txt`, e `'a.txt' <= 'a/x'` (0x2E < 0x2F) fazia o
    // validador recusar. Por isso a ordenação final é sobre o caminho COMPLETO.
    const { root, relative } = await tree({ 'a/x.txt': 'um', 'a.txt': 'dois' })
    const built = await createVerifiedBuildArchive(root, relative)
    const arquivos = tarPaths(await readFile(built.archivePath)).filter(path => !path.endsWith('/'))
    await built.dispose()
    expect(arquivos).toEqual(['a.txt', 'a/x.txt'])
  })

  it('nome fora de NFC é recusado na PRODUÇÃO, onde dá para dizer o que houve', async () => {
    // O validador exige NFC, e um nome criado no macOS costuma chegar em NFD.
    // Deixar passar aqui faria o mesmo nome ser recusado lá na frente como
    // "artefato inválido", longe de onde o problema está.
    const { root, relative } = await tree({ [`cafe${String.fromCharCode(0x0301)}.txt`]: 'um' })
    await expect(createVerifiedBuildArchive(root, relative)).rejects.toThrow('ARTIFACT_UNSAFE_ENTRY')
    // E o mesmo nome em NFC passa: a regra é sobre a FORMA, não sobre o acento.
    const composto = await tree({ 'café.txt': 'um' })
    const ok = await createVerifiedBuildArchive(composto.root, composto.relative)
    expect(ok.files).toBe(1)
    await ok.dispose()
  })

  it('ArtifactIngressError continua sendo a classe que a ingestão usa', () => {
    // Guarda de importação: se o código de erro mudasse de casa, este arquivo
    // deixaria de estar falando do mesmo validador.
    expect(new ArtifactIngressError('ARTIFACT_INVALID').message).toBe('ARTIFACT_INVALID')
  })
})
