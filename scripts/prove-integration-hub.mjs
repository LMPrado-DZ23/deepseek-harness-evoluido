// M5 proof: the real Studio profile with the Integration Hub plugin. Through
// the real HTTP server: sign in by magic code, configure the generated-app
// SMTP by credential reference (value only in the environment, never sent by
// the browser nor stored), see the test refused as NOT_EXECUTED, register a
// signed and an unsigned integration (stable channel refuses to enable the
// unsigned one), export a verified prototype and download a reproducible ZIP.
// Then the Hub panel itself, in real Chromium against the same running Studio
// (apps/studio-web/tests/hub.spec.ts). DZ23_HUB_SKIP_UI=1 records the panel
// as NOT_EXECUTED instead of running it (the decision is then not GO).
//
//   node scripts/prove-integration-hub.mjs
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const studioRoot = resolve(process.cwd())
execFileSync('pnpm', ['build'], { cwd: studioRoot, stdio: 'ignore' })
const upstreamRoot = resolve(process.env.DSH_UPSTREAM_ROOT ?? '/home/leandro/harness-studio-poc02/deepseek-harness')
const runId = randomUUID().slice(0, 8)
const workDir = join(studioRoot, 'runtime', `hub-proof-${runId}`)
const dshHome = join(workDir, 'dsh-home')
assert.ok(existsSync(join(upstreamRoot, '.git')), `missing upstream checkout: ${upstreamRoot}`)

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
process.env.DSH_HOME = dshHome
process.env.DSH_TELEMETRY_DISABLED = '1'
process.env.DZ23_HUB_PUBLISHER_KEYS = JSON.stringify({ dz23: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') })
process.env.DZ23_HUB_CHANNEL = 'stable'
// The SMTP secret lives ONLY in the environment (the vault seam of this profile); the browser sends its name.
process.env.DZ23_APP_SMTP = JSON.stringify({ host: 'smtp.example.test', port: 587, secure: false, user: 'app', pass: 'nunca-sai-do-servidor', from: 'app@example.test' })
delete process.env.DZ23_HUB_SMTP_TEST_ENABLED

const moduleAt = relative => import(pathToFileURL(join(upstreamRoot, relative)).href)
const cliBin = readFileSync(join(upstreamRoot, 'apps/cli/lib/bin.js'), 'utf8')
const profileBootChunk = cliBin.match(/import\("\.\/(profile-boot-[^"]+\.js)"\)/)?.[1]
const [{ loadLayeredEnv }, { runProfile }] = await Promise.all([moduleAt('packages/boot/app-boot/lib/index.js'), moduleAt(`apps/cli/lib/${profileBootChunk}`)])
const { canonicalManifestBytes } = await import('../plugins/integration-hub/lib/manifest.js')
const { readZip } = await import('../plugins/integration-hub/lib/zip.js')
await mkdir(join(dshHome, 'profiles'), { recursive: true })
await symlink(join(studioRoot, 'dsh-home', 'profiles', 'studio'), join(dshHome, 'profiles', 'studio'), 'dir')

const originalLog = console.log
let announced = ''
console.log = (...args) => { if (typeof args[0] === 'string' && args[0].startsWith('dsh web: http://')) announced = args[0]; else originalLog(...args) }
const app = await runProfile({ environment: loadLayeredEnv('dsh-studio-m5-hub', studioRoot), profile: 'studio', patchFiles: [], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] })
console.log = originalLog
const port = app.ctx.webServer.port
const origin = `http://127.0.0.1:${port}`

try {
  // ---- sign in through the real identity service (magic code captured in development mode)
  const identity = app.ctx.studioIdentity.service
  const capture = app.ctx.studioIdentity.developmentEmailCapture
  const email = 'dona.do.negocio@example.test'
  assert.equal(await identity.requestMagicCode(email), 'sent')
  const issued = await identity.verifyMagicCode(email, capture.messages.at(-1).code, { label: 'prova', userAgent: 'node', ipTruncated: '127.0.0.0' })
  const session = await identity.authenticate(issued.token)
  const headers = { host: `127.0.0.1:${port}`, origin, 'content-type': 'application/json', cookie: `dz23_studio_session=${issued.token}; dz23_studio_csrf=${issued.csrfToken}`, 'x-dz23-csrf': issued.csrfToken }
  const hub = (path, init = {}) => fetch(`${origin}/api/studio/hub${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })

  // ---- SMTP by reference: the value never leaves the environment
  assert.deepEqual(await (await hub('/smtp')).json(), { configured: false, secret_ref: null, tier: 'T2' })
  assert.equal((await hub('/smtp', { method: 'POST', body: JSON.stringify({ secret_ref: 'DZ23_NAO_EXISTE' }) })).status, 400)
  const configured = await hub('/smtp', { method: 'POST', body: JSON.stringify({ secret_ref: 'DZ23_APP_SMTP' }) })
  assert.equal(configured.status, 200)
  assert.deepEqual(await configured.json(), { configured: true, secret_ref: 'DZ23_APP_SMTP', tier: 'T2' })
  const test = await (await hub('/smtp/test', { method: 'POST', body: JSON.stringify({ to: email }) })).json()
  assert.equal(test.result, 'NOT_EXECUTED')
  const storedIntegrations = JSON.stringify([...app.ctx.storageDomain.get('studio_integrations').table('integrations').entries()])
  assert.ok(!storedIntegrations.includes('nunca-sai-do-servidor'), 'the SMTP password leaked into storage')

  // ---- registry with D16
  const manifest = { schema_version: 1, id: 'agenda-local', name: 'Agenda local', version: '1.0.0', kind: 'skill', publisher: { id: 'dz23', name: 'DZ23' }, permissions: [], tier: 'T0' }
  const signedManifest = { ...manifest, signature: sign(null, canonicalManifestBytes(manifest), privateKey).toString('base64') }
  const registered = await (await hub('/integrations', { method: 'POST', body: JSON.stringify(signedManifest) })).json()
  assert.equal(registered.integration.verification, 'verified')
  assert.equal((await hub(`/integrations/${registered.integration.integration_id}/enabled`, { method: 'POST', body: '{"enabled":true}' })).status, 200)
  // The D16 rule under test is "unsigned → at least T2" on its own: a read-only skill declaring T0 (no network floor involved).
  const unsigned = await (await hub('/integrations', { method: 'POST', body: JSON.stringify({ ...manifest, id: 'agenda-sem-assinatura', tier: 'T0' }) })).json()
  assert.equal(unsigned.integration.verification, 'unverified')
  assert.equal(unsigned.integration.effective_tier, 'T2')
  assert.equal(unsigned.integration.kind, 'skill')
  assert.equal((await hub(`/integrations/${unsigned.integration.integration_id}/enabled`, { method: 'POST', body: '{"enabled":true}' })).status, 403)
  const listed = await (await hub('/integrations')).json()
  assert.equal(listed.channel, 'stable')
  assert.deepEqual(listed.integrations.map(item => [item.manifest?.id ?? item.kind, item.can_enable]).sort(), [['agenda-local', false], ['agenda-sem-assinatura', false], ['smtp', false]])
  // tampered signature → refused and audited
  assert.equal((await hub('/integrations', { method: 'POST', body: JSON.stringify({ ...signedManifest, name: 'Agenda alterada' }) })).status, 400)

  // ---- a verified project with a PASSED run whose files exist (fabricated standalone build)
  const tenancy = app.ctx.studioTenancy.service
  const authorization = tenancy.authorizationFor(session.user_id, session.org_id, session.tenant_id)
  const actor = { ...authorization, sessionId: session.session_id }
  const p2a = app.ctx.studioPromptToApp.service
  const project = await p2a.createProject(actor, { name: 'Agenda do salão', original_brief: 'Preciso de um aplicativo para as pessoas escolherem horário no meu salão.', category: 'form-database', privacy: 'local-only' })
  const spec = { schema_version: 1, problem: project.original_brief, audience: 'Clientes', journeys: ['Reservar'], pages: [{ name: 'Reservas', sections: ['Cadastro'] }], entities: [{ name: 'Reserva', kind: 'database', sensitive: false, fields: [{ name: 'Nome', type: 'text', required: true }] }], sensitive_data: { detected: [], confirmed_by_user: false }, accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true }, language: 'pt-BR', acceptance_criteria: ['a', 'b', 'c'] }
  await p2a.saveSpec(actor, project.project_id, spec, 'intake')
  await p2a.proposePlan(actor, project.project_id, [{ slice_id: 's1', title: 'Tela', description: 'Tela de reservas', acceptance_criteria: ['a'], planned_files: ['src/GeneratedApp.tsx'] }])
  const plan = await p2a.approvePlan(actor, project.project_id)
  await p2a.transition(actor, project.project_id, 'GENERATING')
  await p2a.transition(actor, project.project_id, 'BUILD_OK')
  await p2a.transition(actor, project.project_id, 'TESTS_OK')
  await p2a.transition(actor, project.project_id, 'VERIFIED_PROTOTYPE')
  const runDirectory = join(workDir, 'runs', 'op-1')
  await mkdir(join(runDirectory, '.next', 'standalone', 'node_modules', 'next'), { recursive: true })
  await mkdir(join(runDirectory, '.next', 'static'), { recursive: true })
  await mkdir(join(runDirectory, 'data'), { recursive: true })
  await mkdir(join(runDirectory, '.next', 'standalone', 'data'), { recursive: true }) // the generated app's own store, where the collector DOES walk
  await mkdir(join(runDirectory, '.next', 'standalone', 'node_modules', 'lib', 'data'), { recursive: true }) // a library folder that happens to be called data/
  await mkdir(join(runDirectory, 'evidence'), { recursive: true })
  await writeFile(join(runDirectory, '.next', 'standalone', 'server.js'), 'console.log("app")')
  await chmod(join(runDirectory, '.next', 'standalone', 'server.js'), 0o755)
  await writeFile(join(runDirectory, '.next', 'standalone', 'node_modules', 'next', 'package.json'), '{}')
  await writeFile(join(runDirectory, '.next', 'standalone', 'node_modules', 'lib', 'data', 'table.json'), '[]')
  await writeFile(join(runDirectory, '.next', 'standalone', 'data', 'app.sqlite'), 'segredo-do-banco-777')
  await writeFile(join(runDirectory, '.next', 'standalone', 'data', 'studio-capture.json'), '[{"kind":"code","email":"x@example.test","code":"654321"}]')
  await writeFile(join(runDirectory, '.next', 'standalone', '.env'), 'APP_SMTP_URL=smtp://u:senha-local@h')
  await writeFile(join(runDirectory, '.next', 'static', 'main.js'), 'chunk')
  await writeFile(join(runDirectory, 'data', 'studio-capture.json'), '[{"kind":"code","email":"x@example.test","code":"654321"}]')
  await writeFile(join(runDirectory, 'evidence', 'appspec-report.json'), '{"schema_version":1,"checks":[]}')
  const now = new Date().toISOString()
  await p2a.putRun(actor, { run_id: 'run-1', operation_id: 'op-1', owner_session_id: session.session_id, plan_id: plan.plan_id, project_id: project.project_id, org_id: actor.orgId, tenant_id: actor.tenantId, stage: 'verify', attempt: 1, state: 'PASSED', started_at: now, finished_at: now, sandbox: 'full', route: 'deterministic', model: 'studio-deterministic', input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0, run_directory: runDirectory, failure_code: null, acceptance_checks: [] })

  // ---- export through HTTP and download
  const created = await hub(`/projects/${project.project_id}/exports`, { method: 'POST', body: '{}' })
  assert.equal(created.status, 201)
  const { export: record } = await created.json()
  assert.equal(record.path, undefined, 'server path must not be exposed')
  const download = await hub(`/projects/${project.project_id}/exports/${record.export_id}/download`)
  assert.equal(download.status, 200)
  const archive = Buffer.from(await download.arrayBuffer())
  assert.equal(createHash('sha256').update(archive).digest('hex'), record.sha256)
  assert.equal(download.headers.get('x-dz23-sha256'), record.sha256)
  const entries = readZip(archive)
  const names = entries.map(entry => entry.name)
  assert.deepEqual(names, ['.env.example', 'README.md', 'app/.next/static/main.js', 'app/node_modules/lib/data/table.json', 'app/node_modules/next/package.json', 'app/server.js', 'evidence/appspec-report.json'])
  const content = entries.map(entry => entry.data.toString('utf8')).join('\n')
  for (const secret of ['654321', 'nunca-sai-do-servidor', 'segredo-do-banco-777', 'senha-local']) assert.ok(!content.includes(secret), `private data leaked into the package: ${secret}`)
  const again = await (await hub(`/projects/${project.project_id}/exports`, { method: 'POST', body: '{}' })).json()
  assert.equal(again.export.sha256, record.sha256, 'export is not reproducible')
  assert.equal(again.export.export_id, record.export_id, 'a second click must reuse the identical package, not write a twin')
  // download of a package whose file is gone: 404 in words, no server path
  const { rm: removeFile } = await import('node:fs/promises')
  const orphanId = randomUUID()
  await app.ctx.storageDomain.get('studio_integrations').table('exports').put(orphanId, { ...(await app.ctx.storageDomain.get('studio_integrations').table('exports').get(record.export_id)), export_id: orphanId, path: join(workDir, 'gone.zip') })
  const gone = await hub(`/projects/${project.project_id}/exports/${orphanId}/download`)
  assert.equal(gone.status, 404)
  assert.ok(!(await gone.text()).includes(workDir), 'server path leaked')
  void removeFile
  const events = await (await hub('/events')).json()
  const actions = events.events.map(event => `${event.action}:${event.outcome}`)
  for (const expected of ['smtp.configured:success', 'smtp.tested:not-executed', 'integration.registered:success', 'integration.registered:failure', 'integration.enabled:success', 'integration.enabled:failure', 'export.created:success']) assert.ok(actions.includes(expected), `missing audit ${expected}`)

  // ---- the panel in real Chromium against this very Studio (session handed over, nothing mocked)
  let ui = 'NOT_EXECUTED'
  let uiDetail = 'DZ23_HUB_SKIP_UI=1'
  if (process.env.DZ23_HUB_SKIP_UI !== '1') {
    // Asynchronous on purpose: the Studio under test runs in THIS process, so a blocking spawn would freeze its server.
    const playwright = await new Promise(resolvePromise => {
      const child = spawn('pnpm', ['exec', 'playwright', 'test', '-c', 'playwright.hub.config.ts', '--reporter=line'], {
        cwd: join(studioRoot, 'apps', 'studio-web'),
        env: { ...process.env, DZ23_HUB_ORIGIN: origin, DZ23_HUB_SESSION: issued.token, DZ23_HUB_CSRF: issued.csrfToken, DZ23_HUB_PROJECT_ID: project.project_id, DZ23_HUB_PROJECT_NAME: project.name },
      })
      let stdout = ''; let stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.on('close', status => resolvePromise({ status, stdout, stderr }))
    })
    const summary = `${playwright.stdout}\n${playwright.stderr}`.replace(/\u001b\[[0-9;]*[A-Za-z]/gu, '').split('\n').filter(line => /passed|failed|skipped|Error/u.test(line)).join(' | ').slice(0, 400)
    const clean = `${playwright.stdout}\n${playwright.stderr}`.replace(/\u001b\[[0-9;]*[A-Za-z]/gu, '')
    const passed = Number(/(\d+) passed/u.exec(clean)?.[1] ?? 0)
    const skipped = Number(/(\d+) skipped/u.exec(clean)?.[1] ?? 0)
    // A Playwright run that passes by skipping is not a proof: five real tests must have run.
    ui = playwright.status === 0 && passed >= 5 && skipped === 0 ? 'PASS' : 'FAIL'
    uiDetail = `${summary} (${passed} passed, ${skipped} skipped)`
    if (ui !== 'PASS') { process.stderr.write(`${playwright.stdout}\n${playwright.stderr}\n`); throw new Error(`hub panel e2e failed: ${summary}`) }
  }
  const decision = ui === 'PASS' ? 'GO' : 'NO-GO'

  const result = { decision, ui, uiDetail, port, announced: announced !== '', smtp: { configured: true, test: test.result, secretInStorage: false }, registry: { verifiedEnabled: true, unsignedTier: unsigned.integration.effective_tier, unsignedEnableRefused: true }, export: { entries: names.length, sha256: record.sha256.slice(0, 16), reproducible: true, privateLeak: false }, auditEvents: actions.length }
  await writeFile(resolve(studioRoot, 'docs/proofs/M5-integration-hub-proof.md'), `# M5 — Prova do Integration Hub v1 no Studio real

- Resultado: **${decision}** (${new Date().toISOString().slice(0, 10)}, ambiente do Claude, Studio real no profile \`studio\` com o plugin \`@dz23-studio/integration-hub\`)
- Sessão obtida pelo serviço de identidade real em processo (código de acesso por e-mail, captura de desenvolvimento); as chamadas ao Hub passam pelo servidor HTTP real com sessão e CSRF.
- SMTP do aplicativo gerado: o navegador envia só o **nome** da referência (\`DZ23_APP_SMTP\`); o valor fica no ambiente do servidor, é conferido (existe + formato) e **não aparece no armazenamento**; nome inexistente → 400; teste de envio → \`NOT_EXECUTED\` com explicação (provedor ainda não escolhido).
- Registro D16: manifesto assinado (Ed25519) → \`verified\`, ligado; habilidade **sem assinatura** declarando T0 → \`unverified\`, tier efetivo **T2** (piso de não verificado, sem envolver rede), ligar no canal estável → 403; manifesto adulterado → 400 e evento de recusa; \`can_enable\` decidido pelo servidor.
- Exportação: projeto levado a \`VERIFIED_PROTOTYPE\` por \`transition()\` e run \`PASSED\` **simulada** (standalone fabricado com \`server.js\` de uma linha; o pipeline real de geração não foi executado nesta prova) → ZIP com ${String(names.length)} entradas; \`data/\` da raiz do app (sqlite + códigos capturados) e \`.env\` **não** entram, enquanto \`node_modules/lib/data/\` entra; SHA-256 no cabeçalho igual ao arquivo; segundo pedido devolve o mesmo pacote (sem arquivo gêmeo); arquivo sumido → 404 sem caminho do servidor.
- Auditoria: ${String(actions.length)} eventos com organização e espaço de trabalho, incluindo a recusa.
- Interface \`/studio/hub\` em Chromium real contra este mesmo Studio: **${ui}** (${uiDetail}) — tela própria em pt-BR; nome do segredo guardado e teste mostrado como não executado; integração sem assinatura sem botão de ligar; pacote gerado pela tela com SHA-256 igual ao download; sem sessão → 401 na tela e na API.

Não executado: envio SMTP real (depende da escolha do provedor pelo Prado), exportação de um standalone real produzido pelo pipeline (fica para a integração com a M1/fatia 3), aparelho físico, avaliação com pessoas leigas (ADR-016: só no sistema completo).
`)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\nINTEGRATION_HUB=${decision}\n`)
  if (decision !== 'GO') process.exitCode = 1
} finally {
  await app.shutdown.shutdown(0)
  await rm(workDir, { recursive: true, force: true })
}
