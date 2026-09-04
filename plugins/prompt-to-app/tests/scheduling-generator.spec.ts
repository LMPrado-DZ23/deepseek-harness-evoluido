import { describe, expect, it } from 'vitest'
import type { AppSpecV1 } from '../src/appspec.js'
import {
  generateSchedulingLayer,
  SchedulingAccessError,
  SchedulingConflictError,
  SchedulingContractError,
  SchedulingDomain,
  SchedulingTransitionError,
} from '../src/scheduling-generator.js'

const spec: AppSpecV1 = {
  schema_version: 1,
  problem: 'Permitir que clientes reservem um atendimento.',
  audience: 'Clientes',
  journeys: ['Escolher uma data e um hor\u00e1rio dispon\u00edvel'],
  pages: [{ name: 'Agenda', sections: ['Nova reserva', 'Reservas'] }],
  entities: [{
    name: 'Reserva',
    kind: 'database',
    sensitive: false,
    fields: [
      { name: 'Data', type: 'date', required: true },
      { name: 'Hor\u00e1rio', type: 'selection', required: true, options: ['09:00', '10:00'] },
    ],
  }],
  sensitive_data: { detected: [], confirmed_by_user: false },
  accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true },
  language: 'pt-BR',
  acceptance_criteria: ['O cliente reserva somente um hor\u00e1rio dispon\u00edvel.'],
}

const owner = { session: { userId: 'owner-1', role: 'owner' as const, csrf: 'csrf-1' }, csrfSubmitted: 'csrf-1' }
const member = { session: { userId: 'member-1', role: 'member' as const, csrf: 'csrf-2' }, csrfSubmitted: 'csrf-2' }

describe('scheduling generator', () => {
  it('generates one system-owned state schema with a unique date and slot pair', () => {
    const layer = generateSchedulingLayer(spec)
    expect(layer.contract).toEqual({ entity: 'Reserva', dateField: 'Data', slotField: 'Hor\u00e1rio', slots: ['09:00', '10:00'] })
    expect(layer.files.map(file => file.path)).toEqual([
      'src/db/scheduling-migration.ts',
      'src/server/scheduling/repository.ts',
      'src/server/actions/scheduling.ts',
      'src/components/generated/scheduling-panel.tsx',
    ])
    const generated = layer.files.map(file => file.content).join('\n')
    expect(generated).toContain("DEFAULT 'pending' CHECK (\\\"state\\\" IN ('pending','confirmed','cancelled'))")
    expect(generated).toContain('CREATE UNIQUE INDEX IF NOT EXISTS \\\"scheduling_reserva_active_slot\\\"')
    expect(generated).toContain('WHERE \\\"state\\\" <> \'cancelled\'')
    expect(generated).toContain("createdBy:session.userId")
    expect(generated).toContain("target==='confirmed'?['owner']:['owner','member']")
    expect(generated).toContain("list({userId:session.userId,role:session.role})")
    expect(generated).toContain("session.role==='owner'&&row.state==='pending'")
    expect(generated).toContain('date<new Date().toISOString().slice(0,10)')
    expect(generated).toContain('min={today}')
    expect(generated).not.toMatch(/name=["'{]state/u)
    expect(generated).not.toContain("formData.get('state')")
  })

  it('rejects ambiguous entities, fields and model-owned state', () => {
    const twoEntities = { ...spec, entities: [spec.entities[0]!, { ...spec.entities[0]!, name: 'Outra' }] } as AppSpecV1
    expect(() => generateSchedulingLayer(twoEntities)).toThrow(SchedulingContractError)
    const optionalDate = { ...spec, entities: [{ ...spec.entities[0]!, fields: spec.entities[0]!.kind === 'database' ? spec.entities[0]!.fields.map(field => field.type === 'date' ? { ...field, required: false } : field) : [] }] } as AppSpecV1
    expect(() => generateSchedulingLayer(optionalDate)).toThrow('SCHEDULING_DATE_AND_SLOT_MUST_BE_REQUIRED')
    const withState = { ...spec, entities: [{ ...spec.entities[0]!, fields: spec.entities[0]!.kind === 'database' ? [...spec.entities[0]!.fields, { name: 'Estado', type: 'text' as const, required: false }] : [] }] } as AppSpecV1
    expect(() => generateSchedulingLayer(withState)).toThrow('SCHEDULING_STATE_IS_SYSTEM_OWNED')
    const withIgnoredField = { ...spec, entities: [{ ...spec.entities[0]!, fields: spec.entities[0]!.kind === 'database' ? [...spec.entities[0]!.fields, { name: 'Observação', type: 'text' as const, required: false }] : [] }] } as AppSpecV1
    expect(() => generateSchedulingLayer(withIgnoredField)).toThrow('SCHEDULING_SUPPORTS_DATE_AND_SLOT_ONLY')
  })

  it('creates pending reservations and rejects a colliding date and slot', () => {
    const domain = new SchedulingDomain(['09:00', '10:00'], () => 'reservation-1')
    expect(domain.create({ date: '2026-09-10', slot: '09:00' }, owner)).toMatchObject({ state: 'pending', createdBy: 'owner-1' })
    expect(() => domain.create({ date: '2026-09-10', slot: '09:00' }, owner)).toThrow(SchedulingConflictError)
    expect(() => domain.create({ date: '2026-09-11', slot: '10:00', state: 'confirmed' }, owner)).toThrow('SYSTEM_FIELD_IN_SCHEDULING_INPUT')
    expect(() => domain.create({ date: '2026-09-11', slot: '03:17' }, owner)).toThrow('SCHEDULING_SLOT_NOT_ALLOWED')
    try {
      domain.create({ date: '2026-09-10', slot: '09:00' }, owner)
    } catch (error) {
      expect(error).toMatchObject({ message: 'Este horário acabou de ser ocupado. Escolha outro horário.', code: 'SLOT_ALREADY_RESERVED' })
    }
  })

  it('lets members see and cancel only their own reservations while owners operate all', () => {
    const domain = new SchedulingDomain(['09:00', '10:00'], () => 'reservation-2')
    const row = domain.create({ date: '2026-09-12', slot: '10:00' }, member)
    expect(domain.list(member)).toEqual([row])
    const otherMember = { session: { userId: 'member-2', role: 'member' as const, csrf: 'csrf-3' }, csrfSubmitted: 'csrf-3' }
    expect(domain.list(otherMember)).toEqual([])
    expect(() => domain.transition(row.id, 'confirm', otherMember)).toThrow(SchedulingTransitionError)
    expect(() => domain.transition(row.id, 'cancel', otherMember)).toThrow(SchedulingTransitionError)
    expect(() => domain.transition(row.id, 'confirm', member)).toThrow('ROLE_FORBIDDEN')
    expect(domain.transition(row.id, 'confirm', owner).state).toBe('confirmed')
    expect(domain.transition(row.id, 'cancel', member).state).toBe('cancelled')
    expect(domain.create({ date: '2026-09-12', slot: '10:00' }, member).state).toBe('pending')
    expect(() => domain.list({ session: null, csrfSubmitted: undefined })).toThrow(SchedulingAccessError)
    expect(() => domain.list({ session: { userId: 'viewer', role: 'viewer' as never, csrf: 'csrf' }, csrfSubmitted: 'csrf' })).toThrow('ROLE_FORBIDDEN')
    expect(() => domain.list({ session: member.session, csrfSubmitted: 'wrong' })).toThrow('CSRF')
  })
})
