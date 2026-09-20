import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { gravarConferido } from './puxar-imagem.mjs'

// Executa o CLI de produção num processo separado. Só o transporte HTTPS é
// substituído: nenhum registro externo, credencial ou Docker é necessário.
// Isto prova a integridade no download, não a integração com um registro real.
const cli = fileURLToPath(new URL('./puxar-imagem.mjs', import.meta.url))
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

test('downloads simultâneos não compartilham arquivo parcial', async () => {
  const pasta = await mkdtemp(join(tmpdir(), 'frigg-oci-paralelo-'))
  const bytes = Buffer.from('conteúdo conferido')
  try {
    const destino = join(pasta, 'blob')
    await Promise.all(Array.from({ length: 12 }, () => gravarConferido([bytes], destino, digest(bytes))))
    assert.deepEqual(await readFile(destino), bytes)
    assert.deepEqual(await readdir(pasta), ['blob'])
  } finally { await rm(pasta, { recursive: true, force: true }) }
})

test('falha de transporte preserva um destino anterior e remove seu temporário', async () => {
  const pasta = await mkdtemp(join(tmpdir(), 'frigg-oci-interrompido-'))
  try {
    const destino = join(pasta, 'blob'); const anterior = Buffer.from('anterior')
    await writeFile(destino, anterior)
    async function* quebrado() { yield Buffer.from('parcial'); throw new Error('interrompido') }
    await assert.rejects(gravarConferido(quebrado(), destino, digest(anterior)), /interrompido/)
    assert.deepEqual(await readFile(destino), anterior)
    assert.deepEqual(await readdir(pasta), ['blob'])
  } finally { await rm(pasta, { recursive: true, force: true }) }
})

async function executar(cenario) {
  const pasta = await mkdtemp(join(tmpdir(), 'frigg-oci-cli-'))
  const saida = join(pasta, 'imagem')
  const config = Buffer.from('{"architecture":"amd64","os":"linux"}')
  const camada = Buffer.from('camada conhecida e fixada por digest')
  const manifesto = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { digest: digest(config), size: config.length },
    layers: [{ digest: digest(camada), size: camada.length }],
  }))
  const respostas = {
    [`https://registro.invalid/v2/teste/manifests/${digest(manifesto)}`]: manifesto.toString('base64'),
    [`https://registro.invalid/v2/teste/blobs/${digest(config)}`]: config.toString('base64'),
    [`https://registro.invalid/v2/teste/blobs/${digest(camada)}`]: camada.toString('base64'),
  }
  const alvo = cenario === 'config' ? config : cenario === 'manifesto' ? manifesto : camada
  const urlAlvo = Object.keys(respostas).find(url => url.endsWith(digest(alvo)))
  if (['config', 'camada', 'manifesto'].includes(cenario)) respostas[urlAlvo] = Buffer.from('ADULTERADO').toString('base64')
  const preload = join(pasta, 'transporte.mjs')
  await writeFile(preload, `
const respostas = ${JSON.stringify(respostas)};
globalThis.fetch = async url => {
  if (!(url in respostas)) throw new Error('URL inesperada no teste');
  if (${JSON.stringify(cenario)} === 'interrompido' && url === ${JSON.stringify(urlAlvo)}) {
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
      pull(controller) { controller.error(new Error('transferência interrompida')); }
    }));
  }
  return new Response(Buffer.from(respostas[url], 'base64'), {
    headers: { 'content-type': 'application/vnd.oci.image.manifest.v1+json' }
  });
};
`)
  const resultado = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, cli, 'registro.invalid', 'teste', digest(manifesto), saida], { encoding: 'utf8', timeout: 10000 })
  return { pasta, saida, resultado, config, camada, manifesto }
}

test('o CLI grava somente bytes conferidos e anuncia a imagem ao terminar', async () => {
  const r = await executar('valido')
  try {
    assert.equal(r.resultado.status, 0, r.resultado.stderr)
    assert.match(r.resultado.stdout, /imagem-pronta/)
    for (const bytes of [r.config, r.camada, r.manifesto]) {
      assert.deepEqual(await readFile(join(r.saida, 'blobs', 'sha256', digest(bytes).slice(7))), bytes)
    }
    const index = JSON.parse(await readFile(join(r.saida, 'index.json'), 'utf8'))
    assert.equal(index.manifests[0].digest, digest(r.manifesto))
  } finally { await rm(r.pasta, { recursive: true, force: true }) }
})

for (const cenario of ['config', 'camada', 'manifesto', 'interrompido']) {
  test(`o CLI recusa ${cenario}, não anuncia sucesso nem deixa um blob parcial`, async () => {
    const r = await executar(cenario)
    try {
      assert.equal(r.resultado.status, 1, r.resultado.stdout + r.resultado.stderr)
      assert.doesNotMatch(r.resultado.stdout, /imagem-pronta/)
      await assert.rejects(readFile(join(r.saida, 'index.json')), { code: 'ENOENT' })
      const arquivos = await readdir(join(r.saida, 'blobs', 'sha256'))
      const alvo = cenario === 'config' ? r.config : cenario === 'manifesto' ? r.manifesto : r.camada
      assert.ok(!arquivos.includes(digest(alvo).slice(7)), 'o conteúdo recusado foi promovido a blob')
      assert.ok(arquivos.every(nome => /^[0-9a-f]{64}$/.test(nome)), 'sobrou arquivo parcial')
    } finally { await rm(r.pasta, { recursive: true, force: true }) }
  })
}
