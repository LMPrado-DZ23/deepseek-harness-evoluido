import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/**
 * O botão de emergência de UM escopo, gravado em disco.
 *
 * O registro existe por escopo (`org_id:tenant_id`) e não por projeto: uma
 * parada de emergência que só alcançasse um projeto não seria parada de
 * emergência - o que estava queimando podia ser o agente de outro projeto, uma
 * fila ou uma integração.
 *
 * Ele guarda os DOIS lados da história - quem parou e quem religou - porque a
 * pergunta que se faz depois de um incêndio nunca é só "está parado?": é
 * "quem parou, quando, por quê, e quem assumiu a volta".
 */
export const emergencyStopRecordSchema = z.object({
  /** `org_id:tenant_id`. É a chave da tabela e o recorte inteiro da parada. */
  scope_id: z.string().min(1),
  org_id: z.string().min(1),
  tenant_id: z.string().min(1),
  stopped: z.boolean(),
  /** Quem parou. `null` só enquanto nunca ninguém parou este escopo. */
  engaged_by: z.string().nullable(),
  engaged_at: z.iso.datetime().nullable(),
  /**
   * O motivo escrito de quem parou, quando houve.
   *
   * É OPCIONAL de propósito, e essa é a assimetria inteira em um campo: exigir
   * texto para PARAR faria a pessoa redigir enquanto o incêndio corre. Retomar
   * é que exige motivo, e `release_reason` não é anulável por acidente.
   */
  reason: z.string().nullable(),
  released_by: z.string().nullable(),
  released_at: z.iso.datetime().nullable(),
  release_reason: z.string().nullable(),
  updated_at: z.iso.datetime(),
}).strict()

export type EmergencyStopRecord = z.infer<typeof emergencyStopRecordSchema>

declare const emergencyStopKeyBrand: unique symbol
export type EmergencyStopKey = string & { readonly [emergencyStopKeyBrand]: true }

export const STUDIO_EMERGENCY_STOP_PHYSICAL_DOMAIN = 'studio_emergency_stop'
export const STUDIO_EMERGENCY_STOP_LOGICAL_DOMAIN = 'studio.emergency.stop'

export const studioEmergencyStopDomainSpec = defineDomain({
  name: STUDIO_EMERGENCY_STOP_PHYSICAL_DOMAIN,
  // Nasce em 1 e fica em 1. `open()` falha com `version-mismatch` em qualquer
  // instalação que já rodou, e não existe passo de migração nesta API: subir a
  // versão deixaria o botão de emergência sem domínio para abrir - ou seja,
  // apagado - justamente na instalação que já dependia dele. Campo novo entra
  // OPCIONAL, como `reason` entrou.
  version: 1,
  tables: { stops: domainTable<EmergencyStopKey, EmergencyStopRecord>(emergencyStopRecordSchema) },
})

/** A chave do escopo. Uma função só, porque duas grafias diferentes dela seriam dois botões. */
export function emergencyScopeId(scope: { readonly orgId: string; readonly tenantId: string }): string {
  return `${scope.orgId}:${scope.tenantId}`
}
