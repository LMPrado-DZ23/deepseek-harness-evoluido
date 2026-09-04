import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import type { AppSpecV1 } from '../src/appspec.js'
import {
  generateSaasLayer,
  SaasAccessError,
  SaasContractError,
  SaasDomain,
  SaasRecordNotFoundError,
  writeSaasLayer,
} from '../src/saas-generator.js'

const spec: AppSpecV1 = {
  schema_version: 1,
  problem: 'Permitir que uma equipe acompanhe suas próprias solicitações.',
  audience: 'Equipe autenticada',
  journeys: ['Criar, consultar, editar e excluir solicitações'],
  pages: [{ name: 'Solicitações', sections: ['Nova solicitação', 'Minhas solicitações'] }],
  entities: [{
    name: 'Solicitação',
    kind: 'database',
    sensitive: false,
    fields: [{ name: 'Título', type: 'text', required: true }],
  }],
  sensitive_data: { detected: [], confirmed_by_user: false },
  accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true },
  language: 'pt-BR',
  acceptance_criteria: ['Cada membro acessa somente as próprias solicitações.'],
}

const owner = { session: { userId: 'owner-1', role: 'owner' as const, csrf: 'owner-csrf' }, csrfSubmitted: 'owner-csrf' }
const memberA = { session: { userId: 'member-a', role: 'member' as const, csrf: 'a-csrf' }, csrfSubmitted: 'a-csrf' }
const memberB = { session: { userId: 'member-b', role: 'member' as const, csrf: 'b-csrf' }, csrfSubmitted: 'b-csrf' }

describe('authenticated SaaS generator', () => {
  it('generates deterministic ownership persistence and server-only actions', () => {
    const layer = generateSaasLayer(spec, 'saas-authenticated')
    expect(layer.entities).toEqual(['solicitacao'])
    expect(layer.files.map(file => file.path)).toEqual([
      'src/db/saas-migrations.ts',
      'src/server/saas/repository.ts',
      'src/server/actions/saas-records.ts',
      'src/components/generated/saas-panel.tsx',
      'src/components/generated/index.ts',
      'tests/generated-saas-isolation.spec.ts',
    ])
    const source = layer.files.map(file => file.content).join('\n')
    expect(source).toContain('owner_user_id TEXT NOT NULL REFERENCES auth_users(id)')
    expect(source).toContain("requireFormSession(formData,['owner','member'])")
    expect(source).toContain('owner_user_id=?')
    expect(source).toContain("readonly status=404")
    expect(source).toContain('data-testid="solicitacao-saas-form"')
    expect(source).toContain('data-testid={`solicitacao-saas-edit-${row.id}`}')
    expect(source).toContain('updateSaasRecord')
    expect(source).toContain('<dl>')
    expect(source).toContain('<dt>{"Título"}</dt>')
    expect(source).toContain('Tem certeza de que deseja excluir este item?')
    expect(source).toContain('Sim, excluir este item')
    expect(source).not.toContain('<pre>{JSON.stringify(row.payload')
    expect(source).toContain("'__proto__','prototype','constructor'")
    expect(source).toContain('Object.create(null)')
    expect(source).toContain("throw new Error('REQUIRED_FIELD')")
    expect(source).toContain("throw new Error('INVALID_EMAIL')")
    expect(source).toContain("throw new Error('INVALID_DATE')")
    expect(source).toContain("throw new Error('SAAS_PAYLOAD_TOO_LARGE')")
    expect(source).not.toMatch(/formData\.get\(['"](?:owner_user_id|user_id|org_id|tenant_id|role)['"]\)/u)
    for (const file of layer.files) {
      const diagnostics = ts.transpileModule(file.content, {
        fileName: file.path,
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
      }).diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error) ?? []
      expect(diagnostics, file.path).toEqual([])
    }
    expect(generateSaasLayer(spec, 'crud-panel')).toEqual({ entities: [], files: [], protectedPaths: [] })
    expect(generateSaasLayer(spec, 'saas-authenticated')).toEqual(layer)
  })

  it('derives owner_user_id exclusively from the authenticated session', () => {
    const domain = new SaasDomain({ createId: () => 'record-1', now: () => new Date('2026-09-04T03:00:00.000Z') })
    const created = domain.create('Solicitação', { title: 'Minha solicitação' }, memberA)
    expect(created).toMatchObject({ id: 'record-1', entity: 'solicitacao', ownerUserId: 'member-a' })
    expect(() => domain.create('Solicitação', { owner_user_id: 'member-b' }, memberA)).toThrow('AUTHORITY_FIELD_FORBIDDEN')
    expect(() => domain.create('Solicitação', { nested: { role: 'owner' } }, memberA)).toThrow('AUTHORITY_FIELD_FORBIDDEN')
    expect(() => domain.create('Solicitação', JSON.parse('{"__proto__":{"elevated":true}}'), memberA)).toThrow('AUTHORITY_FIELD_FORBIDDEN')
  })

  it('accepts only finite JSON objects and rejects ambiguous entity names', () => {
    const domain = new SaasDomain({ createId: () => 'record-1' })
    const valid = domain.create('Solicitação', { count: 2, active: true, note: null, tags: ['a', 1] }, memberA)
    expect(valid.payload).toEqual({ count: 2, active: true, note: null, tags: ['a', 1] })
    for (const input of ['text', null, ['array'], Number.NaN, new Date(), { '': 'empty' }, { ['x'.repeat(101)]: 'long' }]) {
      expect(() => domain.create('Solicitação', input, memberA)).toThrow(SaasContractError)
    }
    expect(() => domain.create('   ', { title: 'A' }, memberA)).toThrow('INVALID_SAAS_ENTITY')
    expect(() => domain.create('x'.repeat(101), { title: 'A' }, memberA)).toThrow('INVALID_SAAS_ENTITY')
    expect(() => domain.create('Solicitação', { title: 'x'.repeat(2_001) }, memberA)).toThrow('SAAS_STRING_TOO_LARGE')
    expect(() => domain.create('Solicitação', { items: Array.from({ length: 101 }, () => 1) }, memberA)).toThrow('SAAS_ARRAY_TOO_LARGE')
    expect(() => domain.create('Solicitação', Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`k${index}`, index])), memberA)).toThrow('SAAS_OBJECT_TOO_LARGE')
    expect(() => domain.create('Solicitação', { a: 'x'.repeat(2_000), b: 'y'.repeat(2_000), c: 'z'.repeat(2_000), d: 'w'.repeat(2_000), e: 'v'.repeat(2_000), f: 'u'.repeat(2_000), g: 't'.repeat(2_000), h: 's'.repeat(2_000), i: 'r'.repeat(2_000) }, memberA)).toThrow('SAAS_PAYLOAD_TOO_LARGE')
  })

  it('shows each member only their rows while the organization owner sees all', () => {
    let sequence = 0
    const domain = new SaasDomain({ createId: () => `record-${++sequence}`, now: () => new Date('2026-09-04T03:00:00.000Z') })
    const first = domain.create('Solicitação', { title: 'A' }, memberA)
    const second = domain.create('Solicitação', { title: 'B' }, memberB)
    expect(domain.list('Solicitação', { session: memberA.session })).toEqual([first])
    expect(domain.list('Solicitação', { session: memberB.session })).toEqual([second])
    expect(domain.list('Solicitação', { session: owner.session })).toEqual([first, second])
    expect(domain.get(second.id, { session: owner.session })).toEqual(second)
  })

  it('returns the same semantic 404 for a missing row and another member row', () => {
    let sequence = 0
    const domain = new SaasDomain({ createId: () => `record-${++sequence}` })
    const second = domain.create('Solicitação', { title: 'B' }, memberB)
    for (const action of [
      () => domain.get('absent', { session: memberA.session }),
      () => domain.get(second.id, { session: memberA.session }),
      () => domain.update(second.id, { title: 'Attack' }, memberA),
      () => domain.delete(second.id, memberA),
    ]) {
      try {
        action()
        throw new Error('EXPECTED_NOT_FOUND')
      } catch (error) {
        expect(error).toBeInstanceOf(SaasRecordNotFoundError)
        expect(error).toMatchObject({ code: 'NOT_FOUND', status: 404 })
      }
    }
    expect(domain.get(second.id, { session: memberB.session }).payload).toEqual({ title: 'B' })
  })

  it('requires a valid server session and matching CSRF on every mutation', () => {
    const domain = new SaasDomain({ createId: () => 'record-1' })
    expect(() => domain.create('Solicitação', { title: 'A' }, { session: null })).toThrow(SaasAccessError)
    expect(() => domain.create('Solicitação', { title: 'A' }, { session: memberA.session, csrfSubmitted: 'wrong' })).toThrow('CSRF')
    expect(() => domain.create('Solicitação', { title: 'A' }, { session: { ...memberA.session, role: 'viewer' as never }, csrfSubmitted: 'a-csrf' })).toThrow('ROLE_FORBIDDEN')
    const created = domain.create('Solicitação', { title: 'A' }, memberA)
    expect(() => domain.update(created.id, { title: 'B' }, { session: memberA.session })).toThrow('CSRF')
    expect(() => domain.delete(created.id, { session: memberA.session, csrfSubmitted: 'wrong' })).toThrow('CSRF')
  })

  it('writes fixed protected paths once and rejects a SaaS app with no database entity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-saas-'))
    try {
      const layer = generateSaasLayer(spec, 'saas-authenticated')
      await writeSaasLayer(root, layer)
      await expect(readFile(resolve(root, 'src/server/saas/repository.ts'), 'utf8')).resolves.toContain('owner_user_id')
      await expect(writeSaasLayer(root, layer)).rejects.toMatchObject({ code: 'EEXIST' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
    expect(() => generateSaasLayer({ ...spec, entities: [] }, 'saas-authenticated')).toThrow(SaasContractError)
  })
})
