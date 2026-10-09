import { readFileSync } from 'node:fs'

interface CatalogObject { readonly [key: string]: string | CatalogObject }
type CatalogValue = string | CatalogObject

export const STORAGE_POSTGRES_I18N_KEYS = [
  'common.operationCancelled',
  'import.verificationMismatch',
  'journal.identityConflict', 'journal.cannotGoBack', 'journal.invalid', 'journal.changedWhileReading',
  'journal.unauthenticatedHardlink', 'journal.recoveryDirectoryLimit', 'journal.ambiguousPublication',
  'journal.interruptedPublicationFailed', 'journal.existingNotStablePrivateFile', 'journal.publishedNotStable',
  'policy.emptyBundle', 'policy.replacementConfirmationRequired', 'policy.domainLoss', 'policy.recordDetail',
  'policy.globalLossDetail', 'policy.recordLoss', 'policy.unknownObjects', 'policy.foreignInstallation',
  'restore.canonicalStateRequired', 'restore.linuxWriteRequired', 'restore.reservationDisappeared',
  'restore.committedResultInvalid', 'restore.receiptMismatch', 'restore.journalNotReserved',
  'restore.safetyJournalMismatch', 'restore.domainSetMismatch', 'restore.postCommitReconciliation',
  'restore.attemptIdInvalid', 'restore.serverRunning', 'restore.lockHeldByStudio', 'restore.lockHeldByRestore',
  'restore.lockHeldByOther', 'restore.lockOwnerVanished', 'restore.lockInspectionUnavailable', 'restore.layoutTablesMissing', 'restore.layoutColumnsMissing',
  'restore.layoutVersionMissing', 'restore.layoutVersionMismatch', 'restore.safetyLinuxRequired', 'restore.safetyIdentityRequired',
  'restore.backupDestinationExists', 'restore.safetyIdentityInvalid', 'restore.safetyTargetIdentityInvalid',
  'restore.safetyDestinationOwnedByOtherAttempt', 'restore.safetyDestinationUnauthenticatedHardlink',
  'restore.safetyInterruptedPublicationFailed', 'restore.safetyExistingSidecarInvalid',
  'restore.safetySidecarChanged', 'restore.safetySidecarMismatch', 'restore.safetyFileInvalid',
  'restore.safetyFileChangedWhileOpening', 'restore.pgDumpEmpty', 'restore.safetyTooLarge', 'restore.safetyChangedWhileVerifying',
  'restore.pgDumpStdoutUnavailable', 'restore.catalogInspectionFailed', 'restore.unexpectedCatalogName',
  'restore.physicalIdentityFailed', 'restore.objectInspectionFailed', 'restore.auditTableUnrecognized',
  'restore.unknownItem', 'restore.unknownSummary',
  'catalog.function', 'catalog.type', 'catalog.operator', 'catalog.operatorClass', 'catalog.operatorFamily',
  'catalog.conversion', 'catalog.collation', 'catalog.textSearchConfiguration', 'catalog.textSearchDictionary',
  'catalog.textSearchParser', 'catalog.textSearchTemplate', 'catalog.extendedStatistic', 'catalog.extension',
  'catalog.defaultPrivilege', 'catalog.table', 'catalog.partitionedTable', 'catalog.view',
  'catalog.materializedView', 'catalog.sequence', 'catalog.foreignTable', 'catalog.compositeType',
  'catalog.object', 'catalog.column', 'catalog.objectOf',
] as const

export type StoragePostgresI18nKey = typeof STORAGE_POSTGRES_I18N_KEYS[number]

const catalog = JSON.parse(
  readFileSync(new URL('../i18n/pt-BR.json', import.meta.url), 'utf8'),
) as CatalogObject

export function t(
  key: StoragePostgresI18nKey,
  params: Readonly<Record<string, string | number>> = {},
): string {
  const value = key.split('.').reduce<CatalogValue | undefined>((current, part) => {
    return typeof current === 'object' && current !== null && Object.hasOwn(current, part)
      ? current[part]
      : undefined
  }, catalog)
  if (typeof value !== 'string') throw new Error(`I18N_KEY_MISSING:${key}`)
  return value.replace(/\{([a-zA-Z0-9_]+)\}/gu, (_match, name: string) => String(params[name] ?? `{${name}}`))
}
