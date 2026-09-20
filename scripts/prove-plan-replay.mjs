/** Reabre os domínios JSON reais em outro processo e reenvia operações concluídas. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainPromptToAppRepository } from '../plugins/prompt-to-app/lib/domain-repository.js'
import { PromptToAppService } from '../plugins/prompt-to-app/lib/service.js'
import * as model from '../plugins/prompt-to-app/lib/model.js'

const script = fileURLToPath(import.meta.url)
const pluginRequire = createRequire(new URL('../plugins/prompt-to-app/package.json', import.meta.url))
const { Context } = await import(pathToFileURL(pluginRequire.resolve('@deepseek-ai/cordis')).href)
const actor = { userId: 'replay-test-user', orgId: 'replay-test-org', tenantId: 'replay-test-tenant', role: 'owner' }
const edit = { base_revision: 1, slices: [{ slice_id: 'initial', title: 'Título preservado' }], removed: [] }
const editKey = 'plan-edit-restart-0001'; const sliceKey = 'plan-slice-restart-0001'; const uncertainKey = 'plan-uncertain-0001'

async function phase(root, mode) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(join(root, 'domains'))
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  ctx.storage.mount('domain', facility)
  try {
    const specs = [model.studioProjectsDomainSpec, model.studioAppSpecsDomainSpec, model.studioDesignSpecsDomainSpec,
      model.studioIntakeTurnsDomainSpec, model.studioPlansDomainSpec, model.studioRunsDomainSpec,
      model.studioEvidenceDomainSpec, model.studioApprovalsDomainSpec, model.studioCreationKeysDomainSpec]
    const names = ['projects', 'specs', 'designs', 'turns', 'plans', 'runs', 'evidence', 'approvals', 'keys']
    const domains = await Promise.all(specs.map(spec => facility.open(spec)))
    const repository = new DomainPromptToAppRepository(...domains.map((domain, index) => domain.table(names[index])))
    const service = new PromptToAppService({ repository })
    const counterPath = join(root, 'model-calls.json')
    const count = async () => JSON.parse(await readFile(counterPath, 'utf8'))
    const planner = { slice: async () => {
      await writeFile(counterPath, JSON.stringify((await count()) + 1), { mode: 0o600 })
      return { slice: { slice_id: 'contact', title: 'Contato', description: 'Como falar conosco', acceptance_criteria: ['Contato visível'], planned_files: ['src/Contato.tsx'] } }
    } }
    if (mode === 'write') {
      await writeFile(counterPath, '0', { mode: 0o600 })
      const project = await service.createProject(actor, { name: 'Prova de recuperação', original_brief: 'Página para apresentar serviços.', category: 'landing-page', privacy: 'local-only' })
      const id = project.project_id
      await service.saveSpec(actor, id, {
        schema_version: 1, problem: 'Apresentar serviços.', audience: 'Clientes', journeys: ['Conhecer os serviços'], pages: [{ name: 'Início', sections: ['Serviços'] }], entities: [],
        sensitive_data: { detected: [], confirmed_by_user: false }, accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true }, language: 'pt-BR', acceptance_criteria: ['Serviços visíveis'],
      }, 'intake')
      await service.proposePlan(actor, id, [{ slice_id: 'initial', title: 'Início', description: 'Página inicial', acceptance_criteria: ['Página visível'], planned_files: ['src/GeneratedApp.tsx'] }])
      const edited = await service.editPlan(actor, id, edit, editKey)
      const added = await service.addPlanSlice(actor, id, 'Adicionar contato', planner, 'local-only', sliceKey, 2)
      const latest = await service.editPlan(actor, id, { ...edit, base_revision: 3, slices: [{ slice_id: 'initial', title: 'Revisão posterior' }] })
      const uncertain = { slice: async () => { await planner.slice(); throw new Error('Resposta externa perdida') } }
      await assert.rejects(service.addPlanSlice(actor, id, 'Adicionar endereço', uncertain, 'local-only', uncertainKey, 4), /Resposta externa perdida/u)
      await writeFile(join(root, 'expected.json'), JSON.stringify({ id, edited, added, latest, approvals: repository.approvals().length }), { mode: 0o600 })
      assert.equal(await count(), 2)
    } else {
      const expected = JSON.parse(await readFile(join(root, 'expected.json'), 'utf8'))
      assert.deepEqual(await service.editPlan(actor, expected.id, edit, editKey), expected.edited)
      assert.deepEqual(await service.addPlanSlice(actor, expected.id, 'Adicionar contato', planner, 'local-only', sliceKey, 2), expected.added)
      await assert.rejects(service.addPlanSlice(actor, expected.id, 'Adicionar endereço', planner, 'local-only', uncertainKey, 4), { code: 'REPLAY' })
      assert.deepEqual(await service.plan(actor, expected.id), expected.latest)
      assert.equal(repository.approvals().length, expected.approvals)
      assert.equal(await count(), 2, 'reenvio não pode consumir o modelo novamente')
    }
    return { phase: mode, status: 'PASS', modelCalls: await count() }
  } finally {
    await facility.closeAll()
    await backend.close()
  }
}

if (process.argv[2] === '--phase') {
  assert.ok(['write', 'replay'].includes(process.argv[3]))
  assert.ok(process.argv[4])
  console.log(JSON.stringify(await phase(process.argv[4], process.argv[3])))
} else {
  const root = await mkdtemp(join(tmpdir(), 'frigg-plan-replay-'))
  try {
    const results = []
    for (const mode of ['write', 'replay']) {
      const child = spawnSync(process.execPath, [script, '--phase', mode, root], { encoding: 'utf8', timeout: 30_000 })
      assert.equal(child.status, 0, child.stderr || child.error?.message)
      results.push(JSON.parse(child.stdout))
    }
    console.log(JSON.stringify({ proof: 'PLAN_DURABLE_REPLAY', status: 'PASS', storage: 'Harness JSON + DomainPromptToAppRepository', separateProcesses: true, results }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
