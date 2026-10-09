import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

const timestamp = z.iso.datetime()
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
const scope = { org_id: z.string().min(1), tenant_id: z.string().min(1) }

/**
 * O DOMÍNIO da prévia, num lugar só — e a medição que decidiu qual ele é.
 *
 * ## Por que a constante existe
 *
 * Este nome estava escrito à mão em QUATRO lugares: o padrão de host deste
 * modelo, a expressão do portão, a criação do host no serviço e a conferência
 * de `frame-src` no plugin da interface. Quatro cópias que precisavam
 * concordar, e nada as obrigava a concordar — a forma mais barata da segunda
 * verdade mais cara deste repositório. Agora há uma, e as outras três derivam
 * dela.
 *
 * ## Por que ele continua sendo irmão do domínio do FRIGG
 *
 * `T-37` e `IB-11` pedem o contrário: enquanto a prévia e o FRIGG são
 * subdomínios do mesmo domínio registrável, o aplicativo GERADO pode escrever
 * `Domain=dz23.localhost` e alcançar o FRIGG.
 *
 * A separação foi IMPLEMENTADA e MEDIDA em 18/09/2026, e ela quebra a prévia:
 * o cookie de admissão é `SameSite=Strict`, e um quadro de OUTRO site é
 * contexto cross-site — o navegador simplesmente não o envia. Medido no
 * Chromium do Playwright: a troca do bilhete devolve `204`, e o `GET /`
 * seguinte volta `401`, porque o cookie que acabou de ser gravado não viaja.
 * `SameSite=None` resolveria, e exige `Secure`, que exige TLS no host da
 * prévia — e instalar CA raiz é proibido por decisão do titular.
 *
 * Então a separação de domínio fica BLOQUEADA em certificado, e não em código:
 * está registrada assim em `T-37`. O que fecha o buraco sem TLS é alcançar o
 * `Path` que a remoção do cookie vizinho não alcançava, e é isso que
 * `shadowCookieDeletions` passou a fazer.
 */
export const DOMINIO_DA_PREVIA = 'dz23.localhost'

/** O host de uma prévia: um rótulo aleatório dentro do domínio da prévia. */
export const PADRAO_DO_HOST_DA_PREVIA = new RegExp(`^p-[a-f0-9]{24}\\.${DOMINIO_DA_PREVIA.replaceAll('.', '\\.')}$`, 'u')

export const previewStateSchema = z.enum([
  'REQUESTED', 'STARTING', 'READY', 'STOPPING', 'STOPPED', 'FAILED', 'EXPIRED',
])
export type PreviewState = z.infer<typeof previewStateSchema>

export const previewRecordSchema = z.object({
  preview_id: z.string().min(1),
  ...scope,
  project_id: z.string().min(1),
  run_id: z.string().min(1),
  artifact_sha256: sha256,
  created_by: z.string().min(1),
  source_session_id: z.string().min(1),
  hostname: z.string().regex(PADRAO_DO_HOST_DA_PREVIA),
  state: previewStateSchema,
  created_at: timestamp,
  ready_at: timestamp.nullable(),
  expires_at: timestamp,
  stopped_at: timestamp.nullable(),
  stop_reason: z.enum(['user', 'expired', 'failed', 'reconciled', 'replaced']).nullable(),
  failure_code: z.string().min(1).nullable(),
  runtime_ref: z.string().min(1).max(200).nullable(),
  health: z.enum(['PENDING', 'OK', 'DOWN']),
}).strict()

export const previewAdmissionSchema = z.object({
  admission_id: z.string().min(1),
  preview_id: z.string().min(1),
  ...scope,
  user_id: z.string().min(1),
  source_session_id: z.string().min(1),
  ticket_hash: sha256,
  cookie_hash: sha256.nullable(),
  created_at: timestamp,
  expires_at: timestamp,
  exchanged_at: timestamp.nullable(),
  revoked_at: timestamp.nullable(),
}).strict()

export type PreviewRecord = z.infer<typeof previewRecordSchema>
export type PreviewAdmission = z.infer<typeof previewAdmissionSchema>

declare const previewKeyBrand: unique symbol
export type PreviewKey = string & { readonly [previewKeyBrand]: true }

export const STUDIO_PREVIEWS_PHYSICAL_DOMAIN = 'studio_previews'
export const STUDIO_PREVIEWS_LOGICAL_DOMAIN = 'studio.previews'
export const STUDIO_PREVIEW_ADMISSIONS_PHYSICAL_DOMAIN = 'studio_preview_admissions'
export const STUDIO_PREVIEW_ADMISSIONS_LOGICAL_DOMAIN = 'studio.preview.admissions'

export const studioPreviewsDomainSpec = defineDomain({
  name: STUDIO_PREVIEWS_PHYSICAL_DOMAIN,
  version: 1,
  tables: { previews: domainTable<PreviewKey, PreviewRecord>(previewRecordSchema) },
})

export const studioPreviewAdmissionsDomainSpec = defineDomain({
  name: STUDIO_PREVIEW_ADMISSIONS_PHYSICAL_DOMAIN,
  version: 1,
  tables: { admissions: domainTable<PreviewKey, PreviewAdmission>(previewAdmissionSchema) },
})
