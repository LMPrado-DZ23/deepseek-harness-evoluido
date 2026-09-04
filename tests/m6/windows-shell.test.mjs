import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const windows = path.join(root, 'deploy', 'windows')
const scripts = ['install.ps1', 'doctor.ps1', 'update.ps1', 'uninstall.ps1']
const fullCommit = 'a'.repeat(40)
const image = `registry.example/dz23-studio@sha256:${'b'.repeat(64)}`
const caddyImage = `registry.example/dz23-caddy@sha256:${'c'.repeat(64)}`
const shortTimeoutMs = 45_000
const composeTimeoutMs = 60_000
const simulationTimeoutMs = 420_000

for (const name of scripts) {
  const source = readFileSync(path.join(windows, name), 'utf8')
  assert.doesNotMatch(source, /certutil|Import-Certificate|RootCertificate|netsh|mitm|tproxy|Start-Process\s+[^\n]*-Verb\s+RunAs/i)
  assert.doesNotMatch(source, /TODO|FIXME/)
  assert.match(source, /Set-StrictMode -Version Latest/)
}

const moduleSource = readFileSync(path.join(windows, 'Dz23.Windows.psm1'), 'utf8')
assert.match(moduleSource, /execute novamente como usuário comum/)
assert.match(moduleSource, /microsoft-standard-wsl2/)
assert.match(moduleSource, /contêineres Linux/)
assert.match(moduleSource, /@sha256:\[0-9a-f\]\{64\}/)
assert.match(moduleSource, /Resolve-Dz23InstallRoot/)
assert.match(moduleSource, /ext2\/ext3\|ext2\|ext3\|ext4/)
assert.match(moduleSource, /--untracked-files=all/)
assert.match(moduleSource, /assert_managed_directory/)
assert.match(moduleSource, /mountpoint -q/)
assert.match(moduleSource, /A origem Git do release diverge da origem auditada/)
assert.match(moduleSource, /ConvertTo-Dz23WslSourcePath/)
assert.match(moduleSource, /wslpath', '-a'/)
assert.match(moduleSource, /assert_upstream_source_pin/)
assert.match(moduleSource, /UPSTREAM\.lock/)
assert.match(moduleSource, /assert_compose_images_pinned/)
assert.match(moduleSource, /flock -n 9/)
assert.match(moduleSource, /operation\.journal/)
assert.match(moduleSource, /com\.dz23\.studio\.compose-sha256/)
assert.match(moduleSource, /Serviço sem saúde/)
assert.match(moduleSource, /test "\$health" = healthy/)
assert.match(moduleSource, /assert_project_resources_owned/)
assert.match(moduleSource, /docker network ls/)
assert.match(moduleSource, /name=\^dz23-studio_/)
assert.match(moduleSource, /start_compose_release/)
assert.doesNotMatch(moduleSource, /TODO|FIXME/)

const pwsh = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh'
const probe = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
  $ErrorActionPreference = 'Stop'
  Import-Module '${path.join(windows, 'Dz23.Windows.psm1').replaceAll("'", "''")}' -Force
  Assert-Dz23Commit '${fullCommit}'
  Assert-Dz23ImageDigest '${image}'
  Assert-Dz23LinuxPath '/home/teste/dz23-studio'
  if ((Resolve-Dz23InstallRoot -Distro Ubuntu -InstallRoot '/home/teste/dz23-studio') -ne '/home/teste/dz23-studio') { exit 10 }
  $native = Invoke-Dz23Native -FilePath (Get-Process -Id $PID).Path -ArgumentList @('-NoLogo', '-NoProfile', '-Command', '[Console]::Write("argument with space")')
  if ($native.ExitCode -ne 0 -or $native.StdOut -ne 'argument with space') { Write-Output ($native | ConvertTo-Json -Compress); exit 8 }
  $failed = 0
  try { Assert-Dz23Commit 'abc' } catch { $failed++ }
  try { Assert-Dz23ImageDigest 'dz23-studio:latest' } catch { $failed++ }
  try { Assert-Dz23LinuxPath '/mnt/c/dz23-studio' } catch { $failed++ }
  try { Assert-Dz23LinuxPath '/home' } catch { $failed++ }
  if ($failed -ne 4) { exit 9 }
`], { encoding: 'utf8', timeout: shortTimeoutMs, maxBuffer: 1024 * 1024 })

assert.notEqual(probe.error?.code, 'ENOENT', 'PowerShell 7 é obrigatório; M6 não pode passar sem executar os testes PowerShell.')
assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`)

const update = readFileSync(path.join(windows, 'update.ps1'), 'utf8')
assert.match(update, /start_compose_release/)
assert.doesNotMatch(update, /up -d --build/)
assert.match(update, /rollback executado e readiness da versão anterior confirmado/)
assert.match(update, /rollback não comprovou readiness/)
assert.doesNotMatch(update, /\|\| true/)
const install = readFileSync(path.join(windows, 'install.ps1'), 'utf8')
assert.match(install, /start_compose_release/)
assert.doesNotMatch(install, /up -d --build/)
const uninstall = readFileSync(path.join(windows, 'uninstall.ps1'), 'utf8')
assert.match(uninstall, /preservar dados e releases/)
assert.match(uninstall, /APAGAR DADOS DO DZ23 STUDIO/)
assert.match(uninstall, /label=com\.docker\.compose\.project=dz23-studio/)
assert.match(uninstall, /Não foi possível comprovar a parada/)
assert.match(uninstall, /projeto homônimo/)
assert.match(uninstall, /volume homônimo/)
assert.match(uninstall, /rede homônima/)
assert.match(uninstall, /uninstall_networks/)

const productionCompose = readFileSync(path.join(root, 'docker-compose.yml'), 'utf8')
assert.doesNotMatch(productionCompose, /^\s+build:/m, 'O Compose de release não pode compilar imagens no host.')
assert.match(productionCompose, /DZ23_CADDY_IMAGE/)
assert.match(productionCompose, /com\.dz23\.studio\.installation-id/)
assert.equal((productionCompose.match(/healthcheck:/g) ?? []).length, 3, 'Todos os serviços obrigatórios precisam declarar healthcheck.')
assert.match(productionCompose, /^networks:\s*$[\s\S]*?com\.dz23\.studio\.installation-id/m)
assert.doesNotMatch(productionCompose, /--no-check-certificate/, 'A saúde da borda não pode ignorar validade TLS.')
assert.match(productionCompose, /https:\/\/\$\$\{DZ23_SITE_ADDRESS\}\/healthz/, 'A saúde da borda precisa validar o hostname público.')
const composeEnv = {
  ...process.env,
  DZ23_STUDIO_IMAGE: image,
  DZ23_CADDY_IMAGE: caddyImage,
  DZ23_STUDIO_COMMIT: fullCommit,
  DZ23_INSTALLATION_ID: 'd'.repeat(64),
  DZ23_COMPOSE_SHA256: 'e'.repeat(64),
  DZ23_EDGE_SECRET: 'test', DZ23_PUBLIC_HOST: 'studio.example.test',
  DZ23_PUBLIC_ORIGIN: 'https://studio.example.test', DZ23_RP_ID: 'studio.example.test',
  DZ23_BOOTSTRAP_OWNER_EMAIL: 'owner@example.test', DZ23_SMTP_SECRET: 'test',
  DZ23_POSTGRES_DSN: 'postgres://test', DZ23_SITE_ADDRESS: 'studio.example.test',
  DZ23_ACME_EMAIL: 'ops@example.test', DZ23_POSTGRES_PASSWORD: 'test',
}
const compose = spawnSync('docker', ['compose', '-f', path.join(root, 'docker-compose.yml'), 'config', '--images'], {
  encoding: 'utf8', env: composeEnv, timeout: composeTimeoutMs, maxBuffer: 1024 * 1024,
})
assert.equal(compose.status, 0, `${compose.stdout}\n${compose.stderr}`)
const configuredImages = compose.stdout.trim().split(/\r?\n/).filter(Boolean)
assert.ok(configuredImages.includes(image))
assert.ok(configuredImages.includes(caddyImage))
assert.ok(configuredImages.every(value => /^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9][a-z0-9._-]*)?@sha256:[0-9a-f]{64}$/.test(value)), configuredImages.join('\n'))

const readme = readFileSync(path.join(windows, 'README.md'), 'utf8')
assert.match(readme, /PurgeConfirmation 'APAGAR DADOS DO DZ23 STUDIO'/)
assert.match(readme, /-Confirm:\$false/)

const timeoutProof = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(root, 'tests', 'm6', 'prove-native-timeout.ps1')], {
  encoding: 'utf8', timeout: shortTimeoutMs, maxBuffer: 1024 * 1024,
})
assert.equal(timeoutProof.status, 0, `${timeoutProof.stdout}\n${timeoutProof.stderr}\n${timeoutProof.error ?? ''}`)
assert.match(timeoutProof.stdout, /M6_NATIVE_TIMEOUT=PASS tree=terminated secret=redacted output=bounded/)

const simulation = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(root, 'tests', 'm6', 'simulate-windows-shell.ps1')], {
  encoding: 'utf8', timeout: simulationTimeoutMs, maxBuffer: 4 * 1024 * 1024,
})
assert.equal(simulation.status, 0, `${simulation.stdout}\n${simulation.stderr}\n${simulation.error ?? ''}`)
assert.match(simulation.stdout, /M6_COMMAND_SIMULATION=PASS bash=real windows-path=space-unicode upstream-tamper=fail-closed journal=recovered concurrency=locked health=missing-and-unhealthy inventory-error=fail-closed homonym=install-update-uninstall-fail-closed rollback=healthy-and-failed purge=verified/)

console.log('M6 Windows shell: PASS (PowerShell e Bash reais, Docker isolado).')
