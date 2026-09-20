import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

for (const nome of ['normal', 'Leandro Prado', 'usuário #1 100%']) {
  test(`os comandos executam de verdade na pasta ${nome}`, async () => {
    const temporario = await mkdtemp(join(tmpdir(), 'frigg-startup-'))
    const scripts = join(temporario, nome, 'scripts')
    await mkdir(scripts, { recursive: true })
    try {
      for (const file of ['studio-start.mjs', 'studio-doctor.mjs', 'preview-edge.mjs', 'builder-doctor.mjs', 'provision-builder.mjs', 'provision-preview.mjs']) {
        await copyFile(new URL(file, import.meta.url), join(scripts, file))
      }
      for (const script of ['builder-doctor.mjs', 'provision-builder.mjs', 'provision-preview.mjs']) {
        const checked = spawnSync(process.execPath, [join(scripts, script), '--self-test'], { encoding: 'utf8', timeout: 15000 })
        assert.equal(checked.status, 0, checked.stderr)
        assert.match(checked.stdout, /SELF_TEST=PASS/, script)
      }
      const doctor = spawnSync(process.execPath, [join(scripts, 'studio-start.mjs'), '--conferir'], { encoding: 'utf8', timeout: 15000 })
      assert.equal(doctor.status, 1, doctor.stderr)
      assert.match(doctor.stdout, /O Studio ainda não pode abrir/)
      assert.doesNotMatch(doctor.stderr, /ERR_MODULE_NOT_FOUND/)
      // A borda precisa executar e recusar o segredo ausente ANTES de escutar.
      const env = { ...process.env }; delete env.DZ23_EDGE_SECRET
      const edge = spawnSync(process.execPath, [join(scripts, 'preview-edge.mjs')], { env, encoding: 'utf8', timeout: 15000 })
      assert.equal(edge.status, 1)
      assert.match(edge.stderr, /segredo/i)
      // Importar as funções continua sem iniciar processo ou servidor.
      const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(scripts, 'studio-start.mjs')).href)}); console.log('importado')`], { encoding: 'utf8', timeout: 15000 })
      assert.equal(imported.status, 0, imported.stderr)
      assert.equal(imported.stdout.trim(), 'importado')
    } finally { await rm(temporario, { recursive: true, force: true }) }
  })
}


test('o launcher anuncia só a interface FRIGG mesmo com o convite dividido em chunks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'frigg-entry-'))
  const file = async (path, content = '{}') => {
    const target = join(root, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content)
  }
  try {
    for (const name of ['studio-start.mjs', 'studio-doctor.mjs', 'preview-edge.mjs', 'builder-doctor.mjs', 'provision-builder.mjs', 'provision-preview.mjs']) {
      await file(`scripts/${name}`, await readFile(new URL(name, import.meta.url)))
    }
    await file('.nvmrc', process.versions.node)
    for (const path of [
      'third_party/deepseek-harness/package.json',
      'third_party/deepseek-harness/packages/core/agent-default-model/lib/presente',
      'node_modules/@dz23-studio/presente', 'plugins/prompt-to-app/lib/presente',
      'dsh-home/profiles/studio/package.json',
      'third_party/deepseek-harness/node_modules/@deepseek-ai/dsh-app-boot/index.js',
    ]) await file(path)
    await file('third_party/deepseek-harness/node_modules/@deepseek-ai/dsh-app-boot/package.json', JSON.stringify({ main: 'index.js' }))
    // Só a fronteira do processo filho é fixture. Executa o launcher real.
    await file('third_party/deepseek-harness/apps/cli/lib/bin.js', `
      if (!process.argv.includes('--no-open')) process.exit(91)
      process.stdout.write('dsh web: http://127.0.0.1:3080/')
      setTimeout(() => process.stdout.write('?token=fixture-not-a-secret\\n'), 20)
    `)
    const result = spawnSync(process.execPath, [join(root, 'scripts/studio-start.mjs')], { encoding: 'utf8', timeout: 15000 })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /FRIGG — abra este endereço: http:\/\/127\.0\.0\.1:3080\/studio\/\?token=fixture-not-a-secret/)
    assert.doesNotMatch(result.stdout, /dsh web: http/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
