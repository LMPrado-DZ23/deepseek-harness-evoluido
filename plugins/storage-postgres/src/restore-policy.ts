import type { StorageExportBundle } from './bundle.js'
import { postgresToolConnection, type TlsPolicy } from './dsn.js'

export function assertRestoreIntent(write: boolean, safetyBackup: string | undefined): void {
  if (write && (safetyBackup === undefined || safetyBackup === '')) throw new Error('safetyBackup is mandatory when write is enabled')
}

export function assertRestorableBundle(bundle: StorageExportBundle): void {
  if (!Array.isArray(bundle.domains) || bundle.domains.length === 0) {
    throw new Error('O arquivo de cópia não contém nenhum domínio. Nada seria restaurado — só apagado. Importação recusada.')
  }
}

export function assertReplacementAllowed(targetHasContent: boolean, force: boolean, confirmation: string | undefined): void {
  if (targetHasContent && !(force && confirmation === 'REPLACE_DZ23_STORAGE')) {
    throw new Error('O esquema de destino já tem conteúdo. Use a confirmação REPLACE_DZ23_STORAGE só depois de conferir a cópia de segurança.')
  }
}

export function assertDomainLossAllowed(wouldBeLost: readonly string[], allowed: boolean, confirmation: string | undefined): void {
  if (wouldBeLost.length > 0 && !(allowed && confirmation === 'REPLACE_DZ23_STORAGE')) {
    throw new Error(`Esta cópia não contém ${String(wouldBeLost.length)} conjunto(s) de dados que existem no destino (${wouldBeLost.join(', ')}). Restaurar assim apagaria esses dados. Importação recusada.`)
  }
}

export interface RestoreRecordLoss {
  readonly domain: string
  readonly recordsInBackup: number
  readonly recordsInTarget: number
  readonly globalWouldBeLost: boolean
}

export function assertRecordLossAllowed(
  losses: readonly RestoreRecordLoss[],
  allowed: boolean,
  confirmation: string | undefined,
): void {
  const destructiveLosses = losses.filter(loss =>
    loss.recordsInBackup < loss.recordsInTarget || loss.globalWouldBeLost,
  )
  if (destructiveLosses.length === 0 || (allowed && confirmation === 'REPLACE_DZ23_STORAGE')) return

  const recordsLost = destructiveLosses.reduce(
    (total, loss) => total + Math.max(0, loss.recordsInTarget - loss.recordsInBackup),
    0,
  )
  const details = destructiveLosses.map((loss) => {
    const records = `${loss.domain}: a cópia traz ${String(loss.recordsInBackup)} registro(s) e o destino tem ${String(loss.recordsInTarget)}`
    return loss.globalWouldBeLost ? `${records}; o valor global também seria apagado` : records
  }).join('; ')
  throw new Error(`Esta cópia substituiria dados por domínio com perda de ${String(recordsLost)} registro(s) e/ou valor global (${details}). Importação recusada. Para autorizar conscientemente, use --allow-record-loss junto com --confirm REPLACE_DZ23_STORAGE.`)
}

export function assertUnknownObjectsAllowed(
  unknownObjects: readonly string[],
  allowed: boolean,
  confirmation: string | undefined,
): void {
  if (unknownObjects.length === 0 || (allowed && confirmation === 'REPLACE_DZ23_STORAGE')) return
  throw new Error(`O destino contém ${String(unknownObjects.length)} objeto(s) que esta versão do DZ23 STUDIO não reconhece (${unknownObjects.join(', ')}). Restaurar apagaria esses objetos sem saber o que guardam. Importação recusada. Para autorizar conscientemente, use --allow-unknown-objects junto com --confirm REPLACE_DZ23_STORAGE.`)
}

export function assertForeignInstallationAllowed(
  backupInstallation: string | null | undefined,
  targetInstallation: string | null | undefined,
  allowed: boolean,
  confirmation: string | undefined,
): void {
  const isForeign = backupInstallation !== undefined
    && backupInstallation !== null
    && targetInstallation !== undefined
    && targetInstallation !== null
    && backupInstallation !== targetInstallation
  if (!isForeign || (allowed && confirmation === 'REPLACE_DZ23_STORAGE')) return
  throw new Error(`Esta cópia pertence a outra instalação do DZ23 STUDIO (cópia: ${backupInstallation}; destino: ${targetInstallation}). Restaurar trocaria os dados de um servidor pelos de outro. Importação recusada. Para autorizar conscientemente, use --allow-foreign-installation junto com --confirm REPLACE_DZ23_STORAGE.`)
}

/** Pure process boundary: no connection string is ever an argv item. */
export function postgresDumpInvocation(
  dsn: string,
  schema: string,
  ssl: TlsPolicy,
  environment: NodeJS.ProcessEnv = process.env,
): { command: 'pg_dump'; args: string[]; environment: NodeJS.ProcessEnv } {
  const target = postgresToolConnection(dsn, ssl, environment)
  return {
    command: 'pg_dump',
    args: [`--schema=${schema}`, '--format=custom'],
    environment: { ...target.env, PGDATABASE: target.dsn },
  }
}
