import { describe, expect, it } from 'vitest'
import { isPendingPlanIntent, resolvePendingPlanIntent } from './pendingIntent'

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
