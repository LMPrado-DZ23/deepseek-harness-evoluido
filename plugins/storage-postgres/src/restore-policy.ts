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
