import { describe, expect, it } from 'vitest'
import { isPendingIntent, isPendingPlanIntent, resolvePendingPlanIntent, resolvePendingCreationIntent, resolvePendingRevisionIntent } from './pendingIntent'

const receipt = { slot: 'a'.repeat(64), digest: 'b'.repeat(64), key: 'c'.repeat(32), baseRevision: 3 }

describe('metadados de envio persistidos no aparelho', () => {
  it('reenvia a intenção antiga com a revisão original, mesmo vendo um plano mais novo', () => {
    expect(resolvePendingPlanIntent(receipt, receipt.slot, receipt.digest, 9, () => 'd'.repeat(32))).toBe(receipt)
  })
  it('texto corrigido inicia outra intenção na revisão atual', () => {
    expect(resolvePendingPlanIntent(receipt, receipt.slot, 'e'.repeat(64), 9, () => 'd'.repeat(32)))
      .toEqual({ ...receipt, digest: 'e'.repeat(64), key: 'd'.repeat(32), baseRevision: 9 })
  })
  it('não usa recibo de outro espaço nem conserta metadados inválidos gerando outra chave', () => {
    expect(() => resolvePendingPlanIntent(receipt, 'f'.repeat(64), receipt.digest, 9)).toThrow('PLAN_INTENT_STORAGE_CORRUPTED')
    expect(() => resolvePendingPlanIntent({ ...receipt, key: 'curta' }, receipt.slot, receipt.digest, 9)).toThrow('PLAN_INTENT_STORAGE_CORRUPTED')
  })
  it('aceita apenas recibo completo, sem o texto do pedido', () => {
    expect(isPendingPlanIntent(receipt)).toBe(true)
    expect(isPendingPlanIntent({ ...receipt, text: 'conteúdo privado' })).toBe(false)
  })
  it.each([
    null, [], {}, { ...receipt, slot: 'outro' }, { ...receipt, digest: 'corrompido' },
    { ...receipt, key: 'curta' }, { ...receipt, key: '!'.repeat(32) },
    { ...receipt, baseRevision: 0 }, { ...receipt, baseRevision: 1.5 },
    { ...receipt, baseRevision: Number.MAX_SAFE_INTEGER + 1 },
    { slot: receipt.slot, digest: receipt.digest, key: receipt.key },
  ])('recusa recibo malformado sem criar outra intenção: %#', value => {
    expect(isPendingPlanIntent(value)).toBe(false)
  })
})


describe('criacao duravel sem revisao de plano', () => {
  const creation = { ...receipt, baseRevision: null }
  it('recupera a mesma chave para o mesmo pedido', () => {
    expect(resolvePendingCreationIntent(creation, creation.slot, creation.digest)).toBe(creation)
    expect(isPendingIntent(creation)).toBe(true)
    expect(isPendingPlanIntent(creation)).toBe(false)
  })
  it('mudanca de pedido inicia outra intencao', () => {
    expect(resolvePendingCreationIntent(creation, creation.slot, 'f'.repeat(64), () => 'g'.repeat(32)))
      .toEqual({ ...creation, digest: 'f'.repeat(64), key: 'g'.repeat(32) })
  })
  it('nao confunde recibo de criacao com revisao de plano', () => {
    expect(() => resolvePendingCreationIntent(receipt, receipt.slot, receipt.digest)).toThrow('PLAN_INTENT_STORAGE_CORRUPTED')
    expect(() => resolvePendingPlanIntent(creation, creation.slot, creation.digest, 1)).toThrow('PLAN_INTENT_STORAGE_CORRUPTED')
  })
  it.each([{ ...creation, slot: 'f'.repeat(64) }, { ...creation, text: 'privado' }, { ...creation, key: 'curta' }])('recusa metadados invalidos: %#', value => {
    expect(() => resolvePendingCreationIntent(value, creation.slot, creation.digest)).toThrow('PLAN_INTENT_STORAGE_CORRUPTED')
  })
})


describe('revisao pendente nao perde sua identidade', () => {
  const pending = { ...receipt, baseRevision: null }
  it('recupera a mesma intencao', () => {
    expect(resolvePendingRevisionIntent(pending, pending.slot, pending.digest)).toBe(pending)
  })
  it('reserva antes do primeiro envio', () => {
    expect(resolvePendingRevisionIntent(undefined, receipt.slot, receipt.digest, () => receipt.key)).toEqual(pending)
  })
  it('texto diferente nao substitui a chave necessaria para recuperar revisao incompleta', () => {
    expect(() => resolvePendingRevisionIntent(pending, pending.slot, 'f'.repeat(64))).toThrow('REVISION_INTENT_MISMATCH')
  })
  it.each([receipt, { ...pending, slot: 'f'.repeat(64) }, { ...pending, key: 'curta' }])('recusa metadados invalidos: %#', value => {
    expect(() => resolvePendingRevisionIntent(value, pending.slot, pending.digest)).toThrow('PLAN_INTENT_STORAGE_CORRUPTED')
  })
})
