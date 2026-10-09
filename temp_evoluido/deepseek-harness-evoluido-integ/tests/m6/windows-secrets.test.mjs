import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const script = join(root, 'deploy', 'windows', 'New-Dz23Secrets.ps1')
const example = join(root, 'deploy', 'windows', 'secrets.env.example')
const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8')
const source = readFileSync(script, 'utf8')
const pwsh = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh'
const smtpPassword = "A9!qZ4#nK8'\\$@wT2"

const baseArgs = [
  '-Profile', 'local',
  '-BootstrapOwnerEmail', 'owner@dz23.com.br',
  '-SmtpConfigured',
  '-SmtpHost', 'smtp.gmail.com',
  '-SmtpPort', '465',
  '-SmtpTlsMode', 'implicit-tls',
  '-SmtpUser', 'noreply@dz23.com.br',
  '-SmtpFrom', 'DZ23 Studio <noreply@dz23.com.br>',
  '-ReadSmtpPasswordFromStdin',
  '-NonInteractive',
]

function run(args, options = {}) {
  return spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, ...args], {
    encoding: 'utf8',
    input: options.input ?? `${smtpPassword}\n`,
    env: { ...process.env, ...options.env },
    timeout: 130_000,
    maxBuffer: 1024 * 1024,
  })
}

function runAsync(args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, ...args], {
      env: { ...process.env, ...options.env }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.stdin.end(options.input ?? `${smtpPassword}\n`)
    const timer = setTimeout(() => child.kill(), 130_000)
    child.on('close', status => { clearTimeout(timer); resolveRun({ status, stdout, stderr }) })
  })
}

function waitForWslPath(path, timeoutMs = 10_000) {
  const result = wsl(['/bin/bash', '--noprofile', '--norc', '-c', `for i in $(seq 1 200); do test -e "$1" && exit 0; sleep 0.05; done; exit 1`, '--', path], { timeout: timeoutMs })
  assert.equal(result.status, 0, `O caminho esperado não surgiu: ${path}\n${result.stderr}`)
}

function expectFailure(result, pattern) {
  assert.notEqual(result.error?.code, 'ENOENT', 'PowerShell 7 é obrigatório para a fatia Windows.')
  assert.notEqual(result.status, 0, 'A entrada hostil deveria ser recusada.')
  const output = `${result.stdout}\n${result.stderr}`
  assert.match(output, pattern)
  assert.doesNotMatch(output, new RegExp(smtpPassword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
}

function wsl(args, options = {}) {
  return spawnSync('wsl.exe', ['-d', 'Ubuntu', '--exec', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C.UTF-8', ...args], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, ...options,
  })
}

function decodeEnv(text) {
  const result = new Map()
  for (const line of text.split(/\r?\n/u)) {
    if (!line || line.startsWith('#')) continue
    const split = line.indexOf('=')
    assert.ok(split > 0, 'Linha dotenv inválida.')
    const key = line.slice(0, split)
    const encoded = line.slice(split + 1)
    assert.match(encoded, /^'(?:[^']|\\')*'$/u, `Valor de ${key} não está delimitado.`)
    result.set(key, encoded.slice(1, -1).replaceAll("\\'", "'"))
  }
  return result
}

test('deriva todas as variáveis de primeiro acesso exigidas pelo Compose sem confundir metadados da release', () => {
  const required = [...compose.matchAll(/\$\{([A-Z0-9_]+):\?/gu)].map(match => match[1])
  const releaseManaged = new Set(['DZ23_STUDIO_IMAGE', 'DZ23_CADDY_IMAGE', 'DZ23_STUDIO_COMMIT', 'DZ23_INSTALLATION_ID', 'DZ23_COMPOSE_SHA256'])
  for (const name of required.filter(name => !releaseManaged.has(name))) {
    assert.match(source, new RegExp(`\\b${name}\\b`, 'u'), `${name} não foi contemplada pelo assistente.`)
  }
  assert.doesNotMatch(source, /\b(?:docker(?:\.exe)?|tailscale(?:\.exe)?)\s+(?:compose|run|info|up|serve|funnel)\b|Invoke-WebRequest|Invoke-RestMethod|curl(?:\.exe)?\s+https?:|netsh|certutil|Set-NetFirewall/iu)
  assert.match(source, /'\/usr\/bin\/env', '-i'/u)
  assert.match(source, /\/dev\/urandom/u)
  assert.match(source, /RedirectStandardInput = \$true/u)
  assert.doesNotMatch(source, /Write-(?:Host|Output).*\$(?:smtpJson|plainPassword|SmtpPassword)/iu)
})

test('o arquivo de exemplo é deliberadamente inválido e não contém segredo', () => {
  const text = readFileSync(example, 'utf8')
  assert.match(text, /INTENCIONALMENTE INVÁLIDO/u)
  assert.match(text, /<GERADO_DENTRO_DO_WSL2>/u)
  assert.doesNotMatch(text, /DZ23_EDGE_SECRET='?[0-9a-f]{64,}/u)
  assert.doesNotMatch(text, /postgresql:\/\/[^<\s]+:[^<\s]+@/u)
})

test('recusa campos ausentes, SMTP ausente e senha previsível', () => {
  expectFailure(run(['-NonInteractive']), /Profile é obrigatório/u)
  expectFailure(run(['-Profile', 'local', '-BootstrapOwnerEmail', 'owner@dz23.com.br', '-NonInteractive']), /SMTP real é obrigatório/u)
  expectFailure(run(baseArgs, { input: 'fake-password-value\n' }), /previsível, de teste ou exemplo/u)
  expectFailure(run(baseArgs, { input: 'curta\n' }), /ao menos 12 caracteres/u)
  expectFailure(run(baseArgs.map(value => value === 'implicit-tls' ? 'starttls' : value)), /SmtpTlsMode|implicit-tls/u)
})

test('recusa injeção, e-mail e destinos inseguros antes de gerar segredo', () => {
  expectFailure(run(baseArgs.map(value => value === 'owner@dz23.com.br' ? 'owner@dz23.com.br\nINJETADO=1' : value)), /caractere de controle/u)
  const quotedScript = script.replaceAll("'", "''")
  const nul = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
    & '${quotedScript}' -Profile local -BootstrapOwnerEmail ('owner@dz23.com.br' + [char]0) -SmtpConfigured -SmtpHost smtp.gmail.com -SmtpPort 465 -SmtpTlsMode implicit-tls -SmtpUser noreply@dz23.com.br -SmtpFrom 'DZ23 Studio <noreply@dz23.com.br>' -ReadSmtpPasswordFromStdin -NonInteractive
  `], { encoding: 'utf8', input: `${smtpPassword}\n`, timeout: 30_000, maxBuffer: 1024 * 1024 })
  expectFailure(nul, /caractere de controle/u)
  expectFailure(run(baseArgs.map(value => value === 'owner@dz23.com.br' ? 'owner@example.com' : value)), /reservado|exemplo|teste/u)
  expectFailure(run([...baseArgs, '-Destination', '/mnt/c/segredos/secrets.env']), /fora de \/mnt/u)
  expectFailure(run([...baseArgs, '-Destination', '/home/leandro/../escape/secrets.env']), /sem travessia/u)
})

test('valida coerência dos perfis externo e Tailscale sem alegar configuração', () => {
  const externalBase = baseArgs.slice(baseArgs.indexOf('-BootstrapOwnerEmail'))
  expectFailure(run(['-Profile', 'public', '-Hostname', '127.0.0.1', '-AcmeEmail', 'ops@dz23.com.br', '-AcknowledgeExternalPrerequisites', ...externalBase]), /não pode ser um endereço IP/u)
  expectFailure(run(['-Profile', 'public', '-Hostname', 'studio.dz23.com.br:443', '-AcmeEmail', 'ops@dz23.com.br', '-AcknowledgeExternalPrerequisites', ...externalBase]), /sem protocolo, porta ou caminho/u)
  expectFailure(run(['-Profile', 'public', '-Hostname', 'studio.tailnet.ts.net', '-AcmeEmail', 'ops@dz23.com.br', '-AcknowledgeExternalPrerequisites', ...externalBase]), /perfil tailscale/u)
  expectFailure(run(['-Profile', 'tailscale', '-Hostname', 'studio.dz23.com.br', '-AcmeEmail', 'ops@dz23.com.br', '-AcknowledgeExternalPrerequisites', ...externalBase]), /terminado em \.ts\.net/u)
  expectFailure(run(['-Profile', 'tailscale', '-Hostname', 'studio.tailnet.ts.net', '-AcmeEmail', 'ops@dz23.com.br', ...externalBase]), /AcknowledgeExternalPrerequisites/u)
})

test('perfis público e Tailscale permanecem preparados, mas exigem prova externa', { skip: process.platform !== 'win32' }, () => {
  const externalBase = baseArgs.slice(baseArgs.indexOf('-BootstrapOwnerEmail'))
  const publicResult = run(['-Profile', 'public', '-Hostname', 'studio.dz23.com.br', '-AcmeEmail', 'ops@dz23.com.br', '-AcknowledgeExternalPrerequisites', '-DryRun', ...externalBase])
  assert.equal(publicResult.status, 0, `${publicResult.stdout}\n${publicResult.stderr}`)
  assert.match(publicResult.stdout, /ACCESS=PUBLIC_DNS_ACME_PROOF_REQUIRED/u)
  assert.match(publicResult.stdout, /PENDENCIA=DNS, portas, firewall e emissão ACME/u)
  const tailscaleResult = run(['-Profile', 'tailscale', '-Hostname', 'studio.tailnet.ts.net', '-AcmeEmail', 'ops@dz23.com.br', '-AcknowledgeExternalPrerequisites', '-DryRun', ...externalBase])
  assert.equal(tailscaleResult.status, 0, `${tailscaleResult.stdout}\n${tailscaleResult.stderr}`)
  assert.match(tailscaleResult.stdout, /ACCESS=TAILSCALE_EXTERNAL_PROOF_REQUIRED/u)
  assert.match(tailscaleResult.stdout, /PENDENCIA=Tailscale, identidade, ACL e HTTPS/u)
})

test('dry-run valida no WSL2 sem gerar nem persistir segredos e mascara a saída', { skip: process.platform !== 'win32' }, (t) => {
  const homeProbe = wsl(['/bin/bash', '--noprofile', '--norc', '-c', 'getent passwd "$(id -u)" | cut -d: -f6'])
  if (homeProbe.status !== 0) { t.skip('WSL2 Ubuntu não está disponível para a prova de dry-run.'); return }
  const home = homeProbe.stdout.trim()
  assert.match(home, /^\/(?:home\/[^/]+|root)$/u)
  const destination = `${home}/.config/dz23-m64b-dry-${randomUUID()}/secrets.env`
  const parent = destination.slice(0, destination.lastIndexOf('/'))
  assert.equal(wsl(['/bin/mkdir', '-m', '700', '--', parent]).status, 0)
  t.after(() => wsl(['/bin/rm', '-rf', '--', parent]))
  const result = run([...baseArgs, '-Destination', destination, '-DryRun'])
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /DZ23_FIRST_RUN=DRY_RUN_VALID/u)
  assert.match(result.stdout, /DZ23_EDGE_SECRET=\[NAO_GERADO\]/u)
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(smtpPassword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  const absent = wsl(['/bin/test', '!', '-e', destination])
  assert.equal(absent.status, 0, 'Dry-run criou um artefato no WSL2.')
})

test('transcrição PowerShell e saída não recebem a senha enviada por stdin', { skip: process.platform !== 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'dz23-m64b-transcript-'))
  const transcript = join(directory, 'transcript.txt')
  try {
    const quotedScript = script.replaceAll("'", "''")
    const quotedTranscript = transcript.replaceAll("'", "''")
    const command = `
      Start-Transcript -LiteralPath '${quotedTranscript}' | Out-Null
      try {
        & '${quotedScript}' -Profile local -BootstrapOwnerEmail owner@dz23.com.br -SmtpConfigured -SmtpHost smtp.gmail.com -SmtpPort 465 -SmtpTlsMode implicit-tls -SmtpUser noreply@dz23.com.br -SmtpFrom 'DZ23 Studio <noreply@dz23.com.br>' -ReadSmtpPasswordFromStdin -NonInteractive -DryRun
      } finally { Stop-Transcript | Out-Null }
    `
    const result = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8', input: `${smtpPassword}\n`, timeout: 130_000, maxBuffer: 1024 * 1024,
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}\n${readFileSync(transcript, 'utf8')}`, new RegExp(smtpPassword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('runner WSL2 cria atomicamente em ext4, 0700/0600, com entropia e overwrite recuperável', { skip: process.platform !== 'win32' }, (t) => {
  const homeProbe = wsl(['/bin/bash', '--noprofile', '--norc', '-c', 'getent passwd "$(id -u)" | cut -d: -f6'])
  if (homeProbe.status !== 0) { t.skip('WSL2 Ubuntu não está disponível para a prova de filesystem.'); return }
  const home = homeProbe.stdout.trim()
  assert.match(home, /^\/(?:home\/[^/]+|root)$/u)
  const testRoot = `${home}/.config/dz23-m64b-${randomUUID()}`
  const destination = `${testRoot}/secrets.env`
  t.after(() => {
    assert.match(testRoot, /^\/(?:home\/[^/]+|root)\/\.config\/dz23-m64b-[0-9a-f-]+$/u)
    wsl(['/bin/rm', '-rf', '--', testRoot])
  })
  assert.equal(wsl(['/bin/mkdir', '-m', '700', '--', testRoot]).status, 0)

  const first = run([...baseArgs, '-Destination', destination])
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`)
  assert.match(first.stdout, /DZ23_FIRST_RUN=PREPARED/u)
  assert.match(first.stdout, /DZ23_EDGE_SECRET=\[CONFIGURADO\]/u)
  assert.doesNotMatch(`${first.stdout}\n${first.stderr}`, new RegExp(smtpPassword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  const file = wsl(['/bin/cat', '--', destination])
  assert.equal(file.status, 0)
  const original = file.stdout
  const env = decodeEnv(original)
  assert.match(env.get('DZ23_EDGE_SECRET'), /^[0-9a-f]{96}$/u)
  assert.match(env.get('DZ23_POSTGRES_PASSWORD'), /^[0-9a-f]{64}$/u)
  assert.equal(env.get('DZ23_POSTGRES_DSN'), `postgresql://dz23_studio:${env.get('DZ23_POSTGRES_PASSWORD')}@postgres:5432/dz23_studio`)
  assert.deepEqual(JSON.parse(env.get('DZ23_SMTP_SECRET')), {
    host: 'smtp.gmail.com', port: 465, secure: true, user: 'noreply@dz23.com.br', pass: smtpPassword,
    from: 'DZ23 Studio <noreply@dz23.com.br>',
  })
  const metadata = wsl(['/usr/bin/stat', '-c', '%a %h %U', '--', testRoot, destination])
  assert.equal(metadata.status, 0)
  assert.deepEqual(metadata.stdout.trim().split(/\r?\n/u).map(line => line.split(' ')[0]), ['700', '600'])
  assert.deepEqual(metadata.stdout.trim().split(/\r?\n/u).map(line => line.split(' ')[1]), ['2', '1'])

  expectFailure(run([...baseArgs, '-Destination', destination]), /já existe/u)
  assert.equal(wsl(['/bin/cat', '--', destination]).stdout, original, 'Recusa de overwrite alterou o arquivo.')

  const second = run([...baseArgs, '-Destination', destination, '-Overwrite'])
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`)
  const replacement = wsl(['/bin/cat', '--', destination]).stdout
  assert.notEqual(createHash('sha256').update(replacement).digest('hex'), createHash('sha256').update(original).digest('hex'))
  const backups = wsl(['/usr/bin/find', testRoot, '-maxdepth', '1', '-type', 'f', '-name', 'secrets.env.backup.*', '-printf', '%f %m %n\n'])
  assert.equal(backups.status, 0)
  assert.match(backups.stdout, /^secrets\.env\.backup\.[A-Za-z0-9.]+ 600 1\s*$/u)
  const backupName = backups.stdout.trim().split(' ')[0]
  assert.equal(wsl(['/bin/cat', '--', `${testRoot}/${backupName}`]).stdout, original)
  const leftovers = wsl(['/usr/bin/find', testRoot, '-maxdepth', '1', '-name', '.secrets.env.tmp.*', '-print'])
  assert.equal(leftovers.stdout.trim(), '')
})

test('runner cria o destino padrão em HOME limpo e recusa filesystem não ext por injeção controlada', { skip: process.platform !== 'win32' }, (t) => {
  const homeProbe = wsl(['/bin/bash', '--noprofile', '--norc', '-c', 'getent passwd "$(id -u)" | cut -d: -f6'])
  if (homeProbe.status !== 0) { t.skip('WSL2 Ubuntu não está disponível para a prova de HOME limpo.'); return }
  const realHome = homeProbe.stdout.trim()
  const cleanHome = `${realHome}/dz23-m64b-home-${randomUUID()}`
  assert.match(cleanHome, /^\/(?:home\/[^/]+|root)\/dz23-m64b-home-[0-9a-f-]+$/u)
  t.after(() => wsl(['/bin/rm', '-rf', '--', cleanHome]))
  assert.equal(wsl(['/bin/mkdir', '-m', '700', '--', cleanHome]).status, 0)
  const env = { DZ23_M64B_TEST_MODE: '1' }
  const created = run([...baseArgs, '-TestHomeDirectory', cleanHome], { env })
  assert.equal(created.status, 0, `${created.stdout}\n${created.stderr}`)
  const target = `${cleanHome}/.config/dz23-studio/secrets.env`
  const metadata = wsl(['/usr/bin/stat', '-c', '%a %u', '--', `${cleanHome}/.config`, `${cleanHome}/.config/dz23-studio`, target])
  assert.equal(metadata.status, 0)
  assert.deepEqual(metadata.stdout.trim().split(/\r?\n/u).map(line => line.split(' ')[0]), ['700', '700', '600'])

  const rejectedHome = `${realHome}/dz23-m64b-home-${randomUUID()}`
  t.after(() => wsl(['/bin/rm', '-rf', '--', rejectedHome]))
  assert.equal(wsl(['/bin/mkdir', '-m', '700', '--', rejectedHome]).status, 0)
  expectFailure(run([...baseArgs, '-TestHomeDirectory', rejectedHome, '-TestFilesystemType', 'tmpfs'], { env }), /filesystem Linux ext2\/ext3\/ext4/u)
  assert.equal(wsl(['/bin/test', '!', '-e', `${rejectedHome}/.config`]).status, 0)
})

test('lock exclusivo serializa writers, detecta troca e preserva backup da versão travada', { skip: process.platform !== 'win32' }, async (t) => {
  const homeProbe = wsl(['/bin/bash', '--noprofile', '--norc', '-c', 'getent passwd "$(id -u)" | cut -d: -f6'])
  if (homeProbe.status !== 0) { t.skip('WSL2 Ubuntu não está disponível para a prova de concorrência.'); return }
  const home = homeProbe.stdout.trim()
  const testRoot = `${home}/.config/dz23-m64b-${randomUUID()}`
  const target = `${testRoot}/secrets.env`
  const lock = `${testRoot}/.secrets.env.lock`
  t.after(() => wsl(['/bin/rm', '-rf', '--', testRoot]))
  assert.equal(wsl(['/bin/mkdir', '-m', '700', '--', testRoot]).status, 0)
  const testEnv = { DZ23_M64B_TEST_MODE: '1' }

  const firstPromise = runAsync([...baseArgs, '-Destination', target, '-TestPauseAfterLockMilliseconds', '10000'], { env: testEnv })
  waitForWslPath(lock)
  const concurrent = run([...baseArgs, '-Destination', target], { env: testEnv })
  expectFailure(concurrent, /outra instância oficial/u)
  const first = await firstPromise
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`)
  assert.equal(wsl(['/bin/test', '!', '-e', lock]).status, 0, 'Lock próprio ficou órfão após sucesso.')

  const lockedVersion = wsl(['/bin/cat', '--', target]).stdout
  const swapPromise = runAsync([...baseArgs, '-Destination', target, '-Overwrite', '-TestPauseAfterLockMilliseconds', '10000'], { env: testEnv })
  waitForWslPath(lock)
  assert.equal(wsl(['/bin/bash', '--noprofile', '--norc', '-c', 'cp -- "$1" "$1.swap" && chmod 600 -- "$1.swap" && mv -Tf -- "$1.swap" "$1"', '--', target]).status, 0)
  const swapped = await swapPromise
  expectFailure(swapped, /destino foi trocado/u)
  assert.equal(wsl(['/bin/cat', '--', target]).stdout, lockedVersion)
  assert.equal(wsl(['/bin/test', '!', '-e', lock]).status, 0)

  const overwrite = run([...baseArgs, '-Destination', target, '-Overwrite'])
  assert.equal(overwrite.status, 0, `${overwrite.stdout}\n${overwrite.stderr}`)
  const backups = wsl(['/usr/bin/find', testRoot, '-maxdepth', '1', '-type', 'f', '-name', 'secrets.env.backup.*', '-print'])
  const backupPaths = backups.stdout.trim().split(/\r?\n/u).filter(Boolean)
  assert.equal(backupPaths.length, 1)
  assert.equal(wsl(['/bin/cat', '--', backupPaths[0]]).stdout, lockedVersion)
})

test('runner WSL2 recusa symlink, hardlink, diretório permissivo e limpa falha parcial', { skip: process.platform !== 'win32' }, (t) => {
  const homeProbe = wsl(['/bin/bash', '--noprofile', '--norc', '-c', 'getent passwd "$(id -u)" | cut -d: -f6'])
  if (homeProbe.status !== 0) { t.skip('WSL2 Ubuntu não está disponível para a prova adversarial.'); return }
  const home = homeProbe.stdout.trim()
  const testRoot = `${home}/.config/dz23-m64b-${randomUUID()}`
  assert.match(testRoot, /^\/(?:home\/[^/]+|root)\/\.config\/dz23-m64b-[0-9a-f-]+$/u)
  t.after(() => wsl(['/bin/rm', '-rf', '--', testRoot]))
  assert.equal(wsl(['/bin/mkdir', '-m', '700', '--', testRoot]).status, 0)

  const target = `${testRoot}/secrets.env`
  const outside = `${testRoot}/outside`
  assert.equal(wsl(['/usr/bin/touch', outside]).status, 0)
  assert.equal(wsl(['/bin/ln', '-s', '--', outside, target]).status, 0)
  expectFailure(run([...baseArgs, '-Destination', target, '-Overwrite']), /não pode ser link/u)
  assert.equal(wsl(['/bin/rm', '--', target]).status, 0)
  assert.equal(wsl(['/bin/ln', '--', outside, target]).status, 0)
  expectFailure(run([...baseArgs, '-Destination', target, '-Overwrite']), /hardlink/u)
  assert.equal(wsl(['/bin/rm', '--', target]).status, 0)

  const symlinkParent = `${testRoot}-link`
  t.after(() => wsl(['/bin/rm', '-f', '--', symlinkParent]))
  assert.equal(wsl(['/bin/ln', '-s', '--', testRoot, symlinkParent]).status, 0)
  expectFailure(run([...baseArgs, '-Destination', `${symlinkParent}/secrets.env`]), /diretório (?:pai de um Destination personalizado|de configuração).*não pode ser link/u)

  assert.equal(wsl(['/bin/chmod', '755', '--', testRoot]).status, 0)
  expectFailure(run([...baseArgs, '-Destination', target]), /modo 0700/u)
  assert.equal(wsl(['/bin/chmod', '700', '--', testRoot]).status, 0)
  const failed = run([...baseArgs, '-Destination', target, '-TestFailBeforeCommit'], { env: { DZ23_M64B_TEST_MODE: '1' } })
  expectFailure(failed, /falha de teste antes do commit atômico/u)
  assert.equal(wsl(['/bin/test', '!', '-e', target]).status, 0)
  const leftovers = wsl(['/usr/bin/find', testRoot, '-maxdepth', '1', '-name', '.secrets.env.tmp.*', '-print'])
  assert.equal(leftovers.stdout.trim(), '')
})
