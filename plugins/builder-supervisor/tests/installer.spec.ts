import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { posix } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InstaladorError, gerarManifesto, identidadeDaInstalacao, instalarConstrutor, prepararRaizes, type InstaladorDependencias } from '../src/installer.js'
import { provisionAndActivateBuilderRuntime } from '../src/runtime-activation.js'
import { builderPolicySha256 } from '../src/docker-adapter.js'
import type { BuilderSupervisorRootPolicy } from '../src/supervisor-config.js'

const linux = process.platform === 'linux' ? describe : describe.skip
const limpar: string[] = []
afterEach(async () => { await Promise.all(limpar.splice(0).map(caminho => rm(caminho, { recursive: true, force: true }))) })

const DIGEST = `sha256:${'a'.repeat(64)}`

/**
 * Uma máquina de mentira com raízes, store e diretório de instalação REAIS.
 *
 * O que é dublê são só os efeitos que precisariam de Docker: a imagem, o
 * gerente e o socket. Provisionar e ativar rodam de VERDADE — é exatamente o
 * fio entre essas peças que este arquivo existe para provar.
 */
async function maquina() {
  const raiz = await mkdtemp(posix.join(tmpdir(), 'inst-')); limpar.push(raiz)
  const gerida = posix.join(raiz, 'gerida')
  const raizes: BuilderSupervisorRootPolicy = {
    configRoot: posix.join(gerida, 'config'), secretRoot: posix.join(gerida, 'secrets'), socketRoot: posix.join(gerida, 'run'),
    artifactRoot: posix.join(gerida, 'artifacts'), exportRoot: posix.join(gerida, 'exports'), stateRoot: posix.join(gerida, 'state'),
    dockerSocketPath: posix.join(raiz, 'docker.sock'),
  }
  const storeDir = posix.join(raiz, 'store')
  await mkdir(posix.join(storeDir, 'files', '00'), { recursive: true, mode: 0o755 })
  await writeFile(posix.join(storeDir, 'files', '00', 'abc'), 'conteudo do pacote\n', { mode: 0o644 })
  await writeFile(posix.join(storeDir, 'index.json'), '{"v":2}\n', { mode: 0o644 })
  const diretorioDaInstalacao = posix.join(raiz, 'instalacao')
  const vivos = new Set<string>()
  const sockets = new Set<string>()
  const dependencias: InstaladorDependencias = {
    imagemExiste: vi.fn(async () => true),
    provisionarEAtivar: vi.fn(request => provisionAndActivateBuilderRuntime(request)),
    gerenteVivo: vi.fn(async registro => vivos.has(registro)),
    iniciarGerente: vi.fn(async registro => {
      vivos.add(registro)
      // O gerente de verdade abre o socket de cada escopo ativo; o dublê abre
      // o socket que a instalação vai procurar.
      return { pid: 4242 }
    }),
    socketExiste: vi.fn(async caminho => { sockets.add(caminho); return vivos.size > 0 }),
    esperar: vi.fn(async () => undefined),
    uid: () => process.getuid!(),
  }
  const opcoes = {
    raizes, diretorioDaInstalacao, storeDir, versaoDoStore: 'v2', digestFixado: DIGEST,
    tenantId: 'tenant-local', instanceId: 'instance-local',
  }
  return { raiz, raizes, storeDir, diretorioDaInstalacao, dependencias, opcoes, vivos }
}

linux('o instalador do construtor', () => {
  it('liga as quatro pecas: manifesto, provisionamento, ativacao e gerente', async () => {
    const m = await maquina()
    const resultado = await instalarConstrutor(m.opcoes, m.dependencias)
    expect(resultado.provisionamento).toBe('CREATED')
    expect(resultado.gerente).toBe('INICIADO')
    expect(resultado.manifesto.criado).toBe(true)
    expect(resultado.raizesCriadas).toHaveLength(6)
    // O registro que o PRODUTO lê foi escrito, e aponta para este escopo.
    const registro = JSON.parse(await readFile(posix.join(m.raizes.configRoot, 'manager', 'runtime-registry.json'), 'utf8')) as {
      slots: { scope_id: string; state: string }[]
    }
    expect(registro.slots).toEqual([expect.objectContaining({ scope_id: resultado.escopo, state: 'active' })])
  })

  it('a politica gravada e a MESMA que o adaptador vai atestar', async () => {
    // A atestação compara as duas e reprova com BUILDER_ATTESTATION_FAILED
    // quando divergem: gravar um número calculado de outro jeito deixaria
    // toda construção recusada com o instalador jurando que acertou.
    const m = await maquina()
    const resultado = await instalarConstrutor(m.opcoes, m.dependencias)
    expect(resultado.politicaSha256).toBe(builderPolicySha256({
      imageDigest: DIGEST, scopeId: resultado.escopo, templateStoreVersion: 'v2', templateStoreSha256: resultado.manifesto.treeSha256,
    }))
    const configuracao = await readFile(posix.join(m.raizes.configRoot, 'instances', resultado.escopo, 'policy.sha256'), 'utf8')
    expect(configuracao.trim()).toBe(resultado.politicaSha256)
  })

  it('a SEGUNDA execucao nao duplica nada: mesmo escopo, mesmo gerente, mesmo manifesto', async () => {
    const m = await maquina()
    const primeira = await instalarConstrutor(m.opcoes, m.dependencias)
    const segunda = await instalarConstrutor(m.opcoes, m.dependencias)
    expect(segunda.escopo).toBe(primeira.escopo)
    expect(segunda.instalacaoId).toBe(primeira.instalacaoId)
    expect(segunda.gerente).toBe('JA_ESTAVA_DE_PE')
    expect(segunda.manifesto.criado).toBe(false)
    expect(segunda.raizesCriadas).toEqual([])
    expect(segunda.ativacao).toBe('UNCHANGED')
    expect(m.dependencias.iniciarGerente).toHaveBeenCalledTimes(1)
    // E o diário registra as duas, sem apagar a primeira.
    const diario = (await readFile(posix.join(m.diretorioDaInstalacao, 'instalacoes.jsonl'), 'utf8')).trim().split('\n')
    expect(diario).toHaveLength(2)
  })

  it('imagem ausente recusa ANTES do primeiro efeito', async () => {
    const m = await maquina()
    ;(m.dependencias.imagemExiste as ReturnType<typeof vi.fn>).mockResolvedValue(false)
    await expect(instalarConstrutor(m.opcoes, m.dependencias)).rejects.toMatchObject({ code: 'IMAGEM_AUSENTE' })
    // Nenhuma raiz foi criada, nenhum manifesto, nenhum provisionamento.
    await expect(readFile(posix.join(m.diretorioDaInstalacao, 'installation-id'))).rejects.toThrow()
    expect(m.dependencias.provisionarEAtivar).not.toHaveBeenCalled()
  })

  it('store ausente e digest malformado tambem recusam antes', async () => {
    const m = await maquina()
    await expect(instalarConstrutor({ ...m.opcoes, storeDir: posix.join(m.raiz, 'nao-existe') }, m.dependencias))
      .rejects.toMatchObject({ code: 'STORE_AUSENTE' })
    await expect(instalarConstrutor({ ...m.opcoes, digestFixado: 'dz23-studio-builder:local' }, m.dependencias))
      .rejects.toMatchObject({ code: 'DIGEST_INVALIDO' })
    expect(m.dependencias.provisionarEAtivar).not.toHaveBeenCalled()
  })

  it('o gerente que nao sobe vira GERENTE_NAO_SUBIU, e o socket que nao aparece tem teto', async () => {
    const m = await maquina()
    ;(m.dependencias.iniciarGerente as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('EACCES docker.sock'))
    await expect(instalarConstrutor(m.opcoes, m.dependencias)).rejects.toMatchObject({ code: 'GERENTE_NAO_SUBIU' })
    const n = await maquina()
    ;(n.dependencias.socketExiste as ReturnType<typeof vi.fn>).mockResolvedValue(false)
    await expect(instalarConstrutor(n.opcoes, n.dependencias)).rejects.toMatchObject({ code: 'SOCKET_NAO_RESPONDEU' })
    // A espera é LIMITADA: não fica girando para sempre.
    expect((n.dependencias.esperar as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(121)
  })

  it('uma raiz aberta para o grupo e RECUSADA, e nunca afrouxada nem corrigida', async () => {
    const m = await maquina()
    await mkdir(m.raizes.configRoot, { recursive: true })
    await chmod(m.raizes.configRoot, 0o770)
    await expect(prepararRaizes(m.raizes, process.getuid!())).rejects.toMatchObject({ code: 'RAIZ_INSEGURA' })
    // O modo continua o que era: não é o instalador que decide de quem ela é.
    const { lstat } = await import('node:fs/promises')
    expect((await lstat(m.raizes.configRoot)).mode & 0o777).toBe(0o770)
  })

  it('o store mudou desde a ultima instalacao: o manifesto NAO e sobrescrito', async () => {
    const m = await maquina()
    await mkdir(m.diretorioDaInstalacao, { recursive: true, mode: 0o700 })
    await gerarManifesto(m.storeDir, 'v2', m.diretorioDaInstalacao)
    await writeFile(posix.join(m.storeDir, 'index.json'), '{"v":3}\n', { mode: 0o644 })
    await expect(gerarManifesto(m.storeDir, 'v2', m.diretorioDaInstalacao)).rejects.toMatchObject({ code: 'MANIFESTO_DIVERGENTE' })
  })

  it('a identidade da instalacao e estavel, e lixo no arquivo e recusa', async () => {
    const m = await maquina()
    await mkdir(m.diretorioDaInstalacao, { recursive: true, mode: 0o700 })
    const primeira = await identidadeDaInstalacao(m.diretorioDaInstalacao)
    expect(await identidadeDaInstalacao(m.diretorioDaInstalacao)).toBe(primeira)
    await writeFile(posix.join(m.diretorioDaInstalacao, 'installation-id'), 'lixo\n')
    await expect(identidadeDaInstalacao(m.diretorioDaInstalacao)).rejects.toBeInstanceOf(InstaladorError)
  })

  it('substituir uma instalacao existente por OUTRA imagem e recusado com o codigo do provisionamento', async () => {
    // Substituição destrutiva exige decisão do titular: o instalador recusa e
    // diz por quê, com o código que o provisionamento deu.
    const m = await maquina()
    await instalarConstrutor(m.opcoes, m.dependencias)
    const outra = await instalarConstrutor({ ...m.opcoes, digestFixado: `sha256:${'b'.repeat(64)}` }, m.dependencias).catch(erro => erro)
    expect(outra).toBeInstanceOf(InstaladorError)
    expect((outra as InstaladorError).code).toBe('PROVISIONAMENTO_RECUSADO')
  })
})
