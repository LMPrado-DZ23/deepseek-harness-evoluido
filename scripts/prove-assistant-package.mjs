import { execFile } from 'node:child_process'
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = resolve(root, 'plugins/assistant-bridge')
const agentsPackageRoot = resolve(root, 'plugins/agents')
const agentTeamPackageRoot = resolve(root, 'plugins/agent-team')
const staged = await mkdtemp(join(tmpdir(), 'dz23-assistant-package-'))
const stagedAgents = await mkdtemp(join(tmpdir(), 'dz23-agents-package-'))
const stagedAgentTeam = await mkdtemp(join(tmpdir(), 'dz23-agent-team-package-'))
const stagedProfile = await mkdtemp(join(tmpdir(), 'dz23-assistant-profile-'))
const runtimeGitProofRoot = await mkdtemp(join(tmpdir(), 'dz23-agent-lib-proof-'))
const execFileAsync = promisify(execFile)

try {
  for (const name of ['lib', 'i18n']) await cp(resolve(packageRoot, name), resolve(staged, name), { recursive: true })
  const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'))
  await writeFile(resolve(staged, 'package.json'), JSON.stringify({ type: manifest.type, exports: manifest.exports }))
  const module = await import(pathToFileURL(resolve(staged, 'lib/i18n.js')).href)
  const rendered = module.t('errors.pathCount', { max: 7 })
  if (rendered !== 'Informe entre 1 e 7 caminhos permitidos.') throw new Error(`Catálogo empacotado inválido: ${rendered}`)
  const agentsManifest = JSON.parse(await readFile(resolve(agentsPackageRoot, 'package.json'), 'utf8'))
  if (JSON.stringify(agentsManifest.files) !== JSON.stringify(['lib', 'i18n', 'src'])) {
    throw new Error('O pacote de agentes não inclui explicitamente lib, i18n e src.')
  }
  for (const name of ['lib', 'i18n']) await cp(resolve(agentsPackageRoot, name), resolve(stagedAgents, name), { recursive: true })
  await writeFile(resolve(stagedAgents, 'package.json'), JSON.stringify({ type: agentsManifest.type }))
  const agentTeamManifest = JSON.parse(await readFile(resolve(agentTeamPackageRoot, 'package.json'), 'utf8'))
  if (JSON.stringify(agentTeamManifest.files) !== JSON.stringify(['lib', 'i18n', 'src'])) {
    throw new Error('O pacote de equipe de agentes não inclui explicitamente lib, i18n e src.')
  }
  for (const name of ['lib', 'i18n']) await cp(resolve(agentTeamPackageRoot, name), resolve(stagedAgentTeam, name), { recursive: true })
  await writeFile(resolve(stagedAgentTeam, 'package.json'), JSON.stringify({ type: agentTeamManifest.type }))
  const teamI18n = await import(pathToFileURL(resolve(stagedAgentTeam, 'lib/i18n.js')).href)
  const teamMessage = teamI18n.t('errors.nothingReady')
  if (!teamMessage.includes('Nenhuma tarefa pode começar agora') || /\bpront[oa]s?\b/iu.test(teamMessage)) {
    throw new Error(`Catálogo empacotado da equipe contém estado enganoso: ${teamMessage}`)
  }
  const profileRoot = resolve(root, 'dsh-home/profiles/studio')
  const profileManifest = JSON.parse(await readFile(resolve(profileRoot, 'package.json'), 'utf8'))
  if (profileManifest.dependencies?.['@dz23-studio/assistant-bridge'] !== 'workspace:*') {
    throw new Error('O profile studio não declara a ponte do Assistente.')
  }
  if (profileManifest.dependencies?.['@dz23-studio/agent-team'] !== 'workspace:*') {
    throw new Error('O profile studio não declara a equipe governada de agentes.')
  }
  const rootLock = await readFile(resolve(root, 'pnpm-lock.yaml'), 'utf8')
  const profileImporter = lockImporter(rootLock, 'dsh-home/profiles/studio')
  if (!profileImporter.includes("'@dz23-studio/assistant-bridge':") || !profileImporter.includes('specifier: workspace:*')) {
    throw new Error('O lockfile raiz não fixa a ponte no profile studio.')
  }
  if (!profileImporter.includes("'@dz23-studio/agent-team':")) {
    throw new Error('O lockfile raiz não fixa a equipe governada no profile studio.')
  }
  const presetRoot = resolve(root, 'dsh-home/.agent-presets')
  const preset = await readFile(resolve(presetRoot, 'dz23-assistant/agent.cordis.yml'), 'utf8')
  if (!preset.includes("name: '@dz23-studio/assistant-bridge'")) throw new Error('Preset não monta a ponte do Assistente.')
  for (const composePath of ['docker-compose.yml', 'deploy/caddy/docker-compose.local.yml']) {
    const compose = await readFile(resolve(root, composePath), 'utf8')
    if (!compose.includes('DZ23_COORDINATOR_PRESET_ROOT: /opt/dz23-studio/dsh-home/.agent-presets')) {
      throw new Error(`${composePath} não fixa a raiz portátil dos presets.`)
    }
  }
  await mkdir(resolve(stagedProfile, 'node_modules/@dz23-studio'), { recursive: true })
  await writeFile(resolve(stagedProfile, 'package.json'), JSON.stringify({ type: 'module' }))
  await symlink(packageRoot, resolve(stagedProfile, 'node_modules/@dz23-studio/assistant-bridge'), process.platform === 'win32' ? 'junction' : 'dir')
  await symlink(agentsPackageRoot, resolve(stagedProfile, 'node_modules/@dz23-studio/agents'), process.platform === 'win32' ? 'junction' : 'dir')
  await symlink(agentTeamPackageRoot, resolve(stagedProfile, 'node_modules/@dz23-studio/agent-team'), process.platform === 'win32' ? 'junction' : 'dir')
  const requireFromProfile = createRequire(resolve(stagedProfile, 'package.json'))
  const resolvedPlugin = requireFromProfile.resolve('@dz23-studio/assistant-bridge')
  const plugin = await import(pathToFileURL(resolvedPlugin).href)
  if (plugin.name !== 'dz23-studio-assistant-bridge') throw new Error('O profile resolveu um módulo inesperado para a ponte.')
  if (JSON.stringify(plugin.ASSISTANT_ALLOWED_PROVIDERS) !== JSON.stringify(['spawn-in-process'])) {
    throw new Error(`O pacote anunciou provider externo sem prova de confinamento: ${plugin.ASSISTANT_ALLOWED_PROVIDERS?.join(',')}`)
  }
  const providerEnums = plugin.createAssistantTools({}).filter(tool => tool.name.startsWith('studio_agent_start') || tool.name.startsWith('studio_team_start'))
    .map(tool => tool.parameters.properties.provider.enum)
  if (providerEnums.length !== 4 || providerEnums.some(values => JSON.stringify(values) !== JSON.stringify(['spawn-in-process']))) {
    throw new Error(`O pacote anunciou provider externo no schema: ${JSON.stringify(providerEnums)}`)
  }
  if (plugin.createAssistantTools({}).length !== 13) throw new Error('O pacote não expõe exatamente treze ferramentas governadas.')
  const resolvedAgents = requireFromProfile.resolve('@dz23-studio/agents')
  if (!resolvedAgents.replaceAll('\\', '/').endsWith('/plugins/agents/lib/index.js')) {
    throw new Error(`O profile não resolveu o artefato lib dos agentes: ${resolvedAgents}`)
  }
  const agents = await import(pathToFileURL(resolvedAgents).href)
  if (typeof agents.GitWorktreeManager !== 'function') throw new Error('O export do pacote não expõe GitWorktreeManager.')
  const resolvedAgentTeam = requireFromProfile.resolve('@dz23-studio/agent-team')
  if (!resolvedAgentTeam.replaceAll('\\', '/').endsWith('/plugins/agent-team/lib/index.js')) {
    throw new Error(`O profile não resolveu o artefato lib da equipe: ${resolvedAgentTeam}`)
  }
  const agentTeam = await import(pathToFileURL(resolvedAgentTeam).href)
  if (typeof agentTeam.StudioAgentTeamService !== 'function'
    || agentTeam.STUDIO_AGENT_TEAMS_PHYSICAL_DOMAIN !== 'studio_agent_teams') {
    throw new Error('O pacote da equipe não expõe serviço e domínio esperados.')
  }
  const stagedGit = await import(pathToFileURL(resolve(stagedAgents, 'lib/git.js')).href)
  await proveEmittedGitBoundary(stagedGit.GitWorktreeManager)
  process.stdout.write('ASSISTANT_PACKAGE_PROOF=PASS staged_lib=PASS staged_i18n=PASS profile_manifest=PASS preset_root=PASS plugin_resolve=PASS tools=13 local_provider_only=PASS agents_lib_resolve=PASS agents_staged_lib=PASS agents_staged_i18n=PASS agent_team_lib_resolve=PASS agent_team_staged_lib=PASS agent_team_staged_i18n=PASS git_extensions_blocked=PASS git_driver_name_negative=PASS\n')
} finally {
  await Promise.all([
    rm(staged, { recursive: true, force: true }),
    rm(stagedAgents, { recursive: true, force: true }),
    rm(stagedAgentTeam, { recursive: true, force: true }),
    rm(stagedProfile, { recursive: true, force: true }),
    rm(runtimeGitProofRoot, { recursive: true, force: true }),
  ])
}

function lockImporter(lockfile, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = lockfile.match(new RegExp(`^  ${escaped}:\\r?\\n([\\s\\S]*?)(?=^  [^ \\r\\n].*:\\r?$|^packages:|^snapshots:)`, 'm'))
  if (match === null) throw new Error(`Importador ausente no lockfile raiz: ${name}`)
  return match[0]
}

async function proveEmittedGitBoundary(GitWorktreeManager) {
  if (typeof GitWorktreeManager !== 'function') throw new Error('O artefato lib não exporta GitWorktreeManager.')
  const repository = resolve(runtimeGitProofRoot, 'repository')
  const copies = resolve(runtimeGitProofRoot, 'copies')
  await mkdir(resolve(repository, 'src'), { recursive: true })
  await mkdir(copies, { recursive: true })
  await execFileAsync('git', ['init', '-q'], { cwd: repository })
  await execFileAsync('git', ['config', 'user.email', 'proof@dz23.local'], { cwd: repository })
  await execFileAsync('git', ['config', 'user.name', 'DZ23 Runtime Proof'], { cwd: repository })
  const helper = resolve(repository, 'hostile-filter.cjs')
  const marker = resolve(repository, 'git-extension-executed.log')
  await writeFile(helper, "const fs=require('node:fs');fs.appendFileSync(process.argv[2],'EXECUTED\\n');process.stdin.pipe(process.stdout)\n")
  await writeFile(resolve(repository, '.gitattributes'), '*.evil filter=evil\n*.conditional filter=conditional\n')
  await writeFile(resolve(repository, 'src/safe.evil'), 'safe-filter-content\n')
  await writeFile(resolve(repository, 'src/safe.conditional'), 'safe-conditional-content\n')
  await execFileAsync('git', ['add', '.'], { cwd: repository })
  await execFileAsync('git', ['commit', '-qm', 'runtime git boundary fixture'], { cwd: repository })

  const command = `"${process.execPath.replaceAll('\\', '/')}" "${helper.replaceAll('\\', '/')}" "${marker.replaceAll('\\', '/')}"`
  await execFileAsync('git', ['config', '--local', 'filter.evil.smudge', command], { cwd: repository })
  await execFileAsync('git', ['config', '--local', 'filter.evil.required', 'true'], { cwd: repository })
  const conditionalConfig = resolve(repository, '.git/dz23-worktree-only.config')
  await writeFile(conditionalConfig, [
    '[filter "conditional"]',
    `\tsmudge = ${command}`,
    '\trequired = true',
    '',
  ].join('\n'))
  const worktreePattern = `${resolve(repository, '.git/worktrees').replaceAll('\\', '/')}/**`
  await execFileAsync('git', ['config', '--local', `includeIf.gitdir/i:${worktreePattern}.path`, conditionalConfig], { cwd: repository })

  const manager = new GitWorktreeManager(copies)
  const snapshot = await manager.create(repository, 'runtime-safe')
  if (await readFile(marker, 'utf8').catch(() => '') !== '') {
    throw new Error('O artefato lib executou uma extensão Git controlada pelo repositório.')
  }
  if (await readFile(resolve(snapshot.worktreePath, 'src/safe.evil'), 'utf8') !== 'safe-filter-content\n'
    || await readFile(resolve(snapshot.worktreePath, 'src/safe.conditional'), 'utf8') !== 'safe-conditional-content\n') {
    throw new Error('A neutralização de filtros alterou conteúdo legítimo.')
  }

  await execFileAsync('git', ['config', '--local', 'filter.bad=name.clean', command], { cwd: repository })
  let blocked = false
  try {
    await manager.create(repository, 'runtime-unsafe-name')
  } catch (error) {
    blocked = error?.code === 'WORKTREE_TAMPERED'
  }
  if (!blocked || await lstat(resolve(copies, 'runtime-unsafe-name')).then(() => true, () => false)) {
    throw new Error('O artefato lib não bloqueou um nome de driver fora da allowlist antes do worktree.')
  }
}
