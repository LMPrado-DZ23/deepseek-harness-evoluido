import { describe, expect, it } from 'vitest'
import t from '../i18n/hub.pt-BR.json'
import { actionLabel, approvalNote, approvalPrompt, confirmStep, enableExplanation, exportable, fill, formatBytes, isHubPath, kindLabel, outcomeLabel, tierLabel, verificationLabel, type PolicyTier } from './presentation'

describe('hub presentation', () => {
  it('opens the hub only at /studio/hub (with or without slash)', () => {
    expect(isHubPath('/studio/hub')).toBe(true)
    expect(isHubPath('/studio/hub/')).toBe(true)
    expect(isHubPath('/studio/')).toBe(false)
    expect(isHubPath('/studio/hubx')).toBe(false)
    expect(isHubPath('/studio/hub/extra')).toBe(false)
  })
  it('asks for a confirmation only when the server says so, and says what T3 costs', () => {
    expect(approvalNote({ requires_approval_tier: null })).toBeNull()
    expect(approvalNote({})).toBeNull()
    // A pessoa lê o NOME do nível, não o código: "T2" não significa nada para
    // quem não programa, e a tradução já existia no catálogo — só não era usada
    // justamente na frase que pede a confirmação.
    expect(approvalNote({ requires_approval_tier: 'T2' })).toContain(t.integrations.tier.T2.toLowerCase())
    expect(approvalNote({ requires_approval_tier: 'T2' })).not.toContain('T2')
    expect(approvalPrompt('T2')).toBe(t.confirm.T2)
    expect(approvalPrompt('T3')).toBe(t.confirm.T3)
    expect(approvalPrompt('T3')).toContain('chave de acesso')
  })

  it('asks the server for the decision only after the person confirms, never while the box is shown', async () => {
    const asked: Array<[string, string, string | undefined]> = []
    const ran: string[] = []
    const step = confirmStep({
      tier: 'T2', action: 'smtp.configured', subjectId: 'smtp', payload: 'DZ23_APP_SMTP',
      describe: tier => `nível ${tier}`,
      requestApproval: async (action, subjectId, payload) => { asked.push([action, subjectId, payload]); return { approval_id: 'ap-1', tier: 'T2' } },
      run: async approval => { ran.push(approval.approval_id) },
    })
    // Building the step — which is what putting the box on screen does — sends NOTHING. Asking for
    // the ticket first meant that cancelling had already left a decision, and an audit event, on the
    // server for something the person went on to refuse.
    expect(step.what).toBe('nível T2')
    expect(asked).toEqual([])
    expect(ran).toEqual([])
    expect(await step.confirm()).toEqual({ kind: 'done' })
    expect(asked).toEqual([['smtp.configured', 'smtp', 'DZ23_APP_SMTP']])
    expect(ran).toEqual(['ap-1'])
  })

  it('does nothing when the server now demands a higher level than the box announced', async () => {
    const ran: string[] = []
    const tiers: PolicyTier[] = ['T3', 'T3']
    const step = confirmStep({
      tier: 'T2', action: 'integration.enabled', subjectId: 'i-1',
      describe: tier => `nível ${tier}`,
      requestApproval: async () => ({ approval_id: 'ap-2', tier: tiers.shift() ?? 'T2' }),
      run: async approval => { ran.push(approval.approval_id) },
    })
    const outcome = await step.confirm()
    // The person agreed to T2 and the server now says T3: nothing runs, and the same action comes
    // back as a NEW question at the level it really costs.
    expect(ran).toEqual([])
    expect(outcome.kind).toBe('tier-changed')
    if (outcome.kind !== 'tier-changed') throw new Error('esperado tier-changed')
    expect(outcome.step.tier).toBe('T3')
    expect(outcome.step.what).toBe('nível T3')
    expect(await outcome.step.confirm()).toEqual({ kind: 'done' })
    expect(ran).toEqual(['ap-2'])
  })

  it('translates every kind, tier, action and outcome the server can send', () => {
    for (const kind of ['smtp', 'mcp', 'skill', 'webhook']) expect(kindLabel(kind)).not.toBe(kind)
    // O código do nível NÃO chega à tela: ele é vocabulário de política, e a
    // pessoa lê o que ele significa.
    for (const tier of ['T0', 'T1', 'T2', 'T3'] as const) {
      expect(tierLabel(tier)).toBe(t.integrations.tier[tier].toLowerCase())
      expect(tierLabel(tier)).not.toContain(tier)
    }
    // Um nível que o catálogo não conhece devolve o código: calar seria pior.
    expect(tierLabel('T9')).toBe('T9')
    for (const action of ['smtp.configured', 'smtp.tested', 'integration.registered', 'integration.enabled', 'integration.disabled', 'export.created', 'approval.recorded']) expect(actionLabel(action)).not.toBe(action)
    for (const outcome of ['success', 'failure', 'not-executed']) expect(outcomeLabel(outcome)).not.toBe(outcome)
    expect(verificationLabel('verified')).toBe(t.integrations.verified)
    expect(verificationLabel('unverified')).toBe(t.integrations.unverified)
  })
  it('explains a refused enable in words and stays silent when the server allows it or it is already on', () => {
    expect(enableExplanation({ verification: 'unverified', enabled: false, can_enable: false })).toBe(t.integrations.cannotEnable)
    expect(enableExplanation({ verification: 'verified', enabled: false, can_enable: true })).toBeNull()
    expect(enableExplanation({ verification: 'unverified', enabled: false, can_enable: true })).toBeNull() // dev channel: the server decides
    expect(enableExplanation({ verification: 'verified', enabled: true, can_enable: false })).toBeNull()
  })
  it('only verified prototypes are exportable', () => {
    expect(exportable({ state: 'VERIFIED_PROTOTYPE' })).toBe(true)
    for (const state of ['DRAFT', 'GENERATING', 'BUILD_FAILED', 'TESTS_OK']) expect(exportable({ state })).toBe(false)
  })
  it('formats sizes and fills templates without leaking placeholders', () => {
    expect(formatBytes(512)).toBe('512 B'); expect(formatBytes(2048)).toBe('2.0 KB'); expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB'); expect(formatBytes(-1)).toBe('0 B')
    expect(fill('Baixar {file}', { file: 'a.zip' })).toBe('Baixar a.zip')
    expect(fill('{x}', {})).toBe('{x}')
  })
})
