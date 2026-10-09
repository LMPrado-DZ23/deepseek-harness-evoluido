import { describe, expect, it } from 'vitest'
import type {
  StudioApproval, StudioAppSpecRecord, StudioCreationKey, StudioDesignSpecRecord,
  StudioEvidence, StudioIntakeTurn, StudioPlan, StudioProject, StudioRun,
} from '../src/model.js'
import { PromptToAppError, PromptToAppService, type PromptToAppActor, type PromptToAppRepository } from '../src/service.js'
import { chaveArmazenada } from '../src/creation-key.js'

/**
 * O reenvio depois do tempo esgotado criava DUAS tarefas.
 *
 * Este arquivo cobre os sete cenários que o defeito tem na vida real, e não só
 * o clique duplo — que era o único que o botão ocupado já resolvia. Cada teste
 * abaixo é um deles, nomeado pelo que acontece com a pessoa.
 */
class MemoryRepository implements PromptToAppRepository {
  projectRows: StudioProject[] = []
  keyRows: StudioCreationKey[] = []
  /** Quantas escritas de tarefa foram aceitas; a queda é simulada mexendo aqui. */
  falharAoGravarTarefa = false
  projects = () => this.projectRows
  specs = () => [] as StudioAppSpecRecord[]
  designs = () => [] as StudioDesignSpecRecord[]
  turns = () => [] as StudioIntakeTurn[]
  plans = () => [] as StudioPlan[]
  runs = () => [] as StudioRun[]
  evidence = () => [] as StudioEvidence[]
  approvals = () => [] as StudioApproval[]
  putProject = async (v: StudioProject) => {
    if (this.falharAoGravarTarefa) throw new Error('queda entre a reserva e a tarefa')
    this.projectRows = [...this.projectRows.filter(row => row.project_id !== v.project_id), v]
  }
  putSpec = async () => {}
  putDesign = async () => {}
  putTurn = async () => {}
  putPlan = async () => {}
  putRun = async () => {}
  putEvidence = async () => {}
  putApproval = async () => {}
  creationKeys = () => this.keyRows
  putCreationKey = async (v: StudioCreationKey) => {
    // A escrita CEDE o controle antes de gravar, e isso não é enfeite: um
    // dublê que grava de forma síncrona fecha sozinho a janela de corrida e
    // aprova um serviço sem serialização nenhuma. Foi o que aconteceu na
    // primeira versão deste arquivo — a sabotagem que removia o mutex
    // sobreviveu, porque não havia janela para ninguém entrar.
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const chave = chaveArmazenada({ orgId: v.org_id, tenantId: v.tenant_id, userId: v.user_id }, v.request_key)
    this.keyRows = [
      ...this.keyRows.filter(row => chaveArmazenada({ orgId: row.org_id, tenantId: row.tenant_id, userId: row.user_id }, row.request_key) !== chave),
      v,
    ]
  }
}

const PEDIDO = {
  name: 'Clínica', original_brief: 'quero uma página para a clínica receber contatos',
  category: 'landing-page', privacy: 'privado-local',
} as Pick<StudioProject, 'name' | 'original_brief' | 'category' | 'privacy'>
const CHAVE = 'abcdefghijklmnop'
const ana: PromptToAppActor = { userId: 'user-a', orgId: 'org-a', tenantId: 'tenant-a', role: 'owner' }
const bruno: PromptToAppActor = { userId: 'user-b', orgId: 'org-a', tenantId: 'tenant-a', role: 'owner' }
const outroInquilino: PromptToAppActor = { userId: 'user-c', orgId: 'org-b', tenantId: 'tenant-b', role: 'owner' }

function fixture(repository = new MemoryRepository()) {
  let id = 0
  const service = new PromptToAppService({
    repository, now: () => new Date('2026-09-17T12:00:00.000Z'), createId: () => `proj-${++id}`,
  })
  return { repository, service }
}

describe('UX-02: uma intenção de envio cria UMA tarefa', () => {
  it('o tempo esgotado DEPOIS de persistir não cria a segunda tarefa', async () => {
    // Este é o cenário que ninguém cobria: o servidor gravou, a resposta se
    // perdeu no caminho, a pessoa apertou de novo.
    const { repository, service } = fixture()
    const primeira = await service.createProject(ana, PEDIDO, CHAVE)
    const segunda = await service.createProject(ana, PEDIDO, CHAVE)
    expect(segunda.project_id).toBe(primeira.project_id)
    expect(repository.projectRows).toHaveLength(1)
  })

  it('duas instâncias enviando ao mesmo tempo com a mesma chave criam uma tarefa só', async () => {
    // Duas abas abertas, ou aba e celular. Sem a serialização, as duas leem
    // "não há reserva" antes de qualquer uma gravar.
    const { repository, service } = fixture()
    const [a, b, c] = await Promise.all([
      service.createProject(ana, PEDIDO, CHAVE),
      service.createProject(ana, PEDIDO, CHAVE),
      service.createProject(ana, PEDIDO, CHAVE),
    ])
    expect(a.project_id).toBe(b.project_id)
    expect(b.project_id).toBe(c.project_id)
    expect(repository.projectRows).toHaveLength(1)
    expect(repository.keyRows).toHaveLength(1)
  })

  it('a mesma chave com pedido DIFERENTE é conflito explícito, não a tarefa antiga de volta', async () => {
    const { service } = fixture()
    await service.createProject(ana, PEDIDO, CHAVE)
    await expect(service.createProject(ana, { ...PEDIDO, category: 'catalog' }, CHAVE))
      .rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('a queda entre a reserva e a tarefa deixa a criação RETOMÁVEL, com o mesmo identificador', async () => {
    // Sem a reserva gravada primeiro, este caminho ou perde a tarefa ou cria
    // duas. Com ela, o reenvio termina o que ficou pela metade.
    const repository = new MemoryRepository()
    const { service } = fixture(repository)
    repository.falharAoGravarTarefa = true
    await expect(service.createProject(ana, PEDIDO, CHAVE)).rejects.toThrow('queda entre a reserva e a tarefa')
    expect(repository.projectRows).toHaveLength(0)
    expect(repository.keyRows).toHaveLength(1)
    const reservado = repository.keyRows[0]!.project_id

    repository.falharAoGravarTarefa = false
    const retomada = await service.createProject(ana, PEDIDO, CHAVE)
    expect(retomada.project_id).toBe(reservado)
    expect(repository.projectRows).toHaveLength(1)
  })

  it('a reserva sobrevive ao reinício do processo', async () => {
    // O mutex morre com o processo; a reserva não. É a reserva que responde
    // aqui — um serviço NOVO, com a mesma base, sobre a mesma chave.
    const repository = new MemoryRepository()
    const primeira = await fixture(repository).service.createProject(ana, PEDIDO, CHAVE)
    const depoisDoRestart = fixture(repository).service
    const segunda = await depoisDoRestart.createProject(ana, PEDIDO, CHAVE)
    expect(segunda.project_id).toBe(primeira.project_id)
    expect(repository.projectRows).toHaveLength(1)
  })

  it('uma chave não alcança a tarefa de outra pessoa nem de outro inquilino', async () => {
    const repository = new MemoryRepository()
    const { service } = fixture(repository)
    const daAna = await service.createProject(ana, PEDIDO, CHAVE)
    const doBruno = await service.createProject(bruno, PEDIDO, CHAVE)
    const doOutro = await service.createProject(outroInquilino, PEDIDO, CHAVE)
    expect(doBruno.project_id).not.toBe(daAna.project_id)
    expect(doOutro.project_id).not.toBe(daAna.project_id)
    expect(repository.projectRows).toHaveLength(3)
    expect(repository.keyRows).toHaveLength(3)
  })

  it('uma intenção NOVA, com chave nova, cria a segunda tarefa — o guarda não prende quem quer outro aplicativo', async () => {
    const { repository, service } = fixture()
    await service.createProject(ana, PEDIDO, CHAVE)
    await service.createProject(ana, { ...PEDIDO, original_brief: 'agora quero um catálogo de produtos' }, 'qrstuvwxyz012345')
    expect(repository.projectRows).toHaveLength(2)
  })

  it('recusa chave curta demais antes de gravar qualquer coisa', async () => {
    const { repository, service } = fixture()
    await expect(service.createProject(ana, PEDIDO, 'curta')).rejects.toBeInstanceOf(PromptToAppError)
    expect(repository.keyRows).toHaveLength(0)
    expect(repository.projectRows).toHaveLength(0)
  })

  it('sem chave, cria — é o caminho da instalação que ainda não abriu o domínio', async () => {
    const { repository, service } = fixture()
    await service.createProject(ana, PEDIDO)
    await service.createProject(ana, PEDIDO)
    expect(repository.projectRows).toHaveLength(2)
    expect(repository.keyRows).toHaveLength(0)
  })
})
