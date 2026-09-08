import { postgresToolConnection } from './dsn.js';
import { t } from './i18n.js';
export function assertRestoreIntent(write, safetyBackup) {
    if (write && (safetyBackup === undefined || safetyBackup === ''))
        throw new Error('safetyBackup is mandatory when write is enabled');
}
export function assertRestorableBundle(bundle) {
    if (!Array.isArray(bundle.domains) || bundle.domains.length === 0) {
        throw new Error(t('policy.emptyBundle'));
    }
}
export function assertReplacementAllowed(targetHasContent, force, confirmation) {
    if (targetHasContent && !(force && confirmation === 'REPLACE_DZ23_STORAGE')) {
        throw new Error(t('policy.replacementConfirmationRequired'));
    }
}
export function assertDomainLossAllowed(wouldBeLost, allowed, confirmation) {
    if (wouldBeLost.length > 0 && !(allowed && confirmation === 'REPLACE_DZ23_STORAGE')) {
        throw new Error(t('policy.domainLoss', { count: wouldBeLost.length, domains: wouldBeLost.join(', ') }));
    }
}
export function assertRecordLossAllowed(losses, allowed, confirmation) {
    const destructiveLosses = losses.filter(loss => loss.recordsInBackup < loss.recordsInTarget || loss.globalWouldBeLost);
    if (destructiveLosses.length === 0 || (allowed && confirmation === 'REPLACE_DZ23_STORAGE'))
        return;
    const recordsLost = destructiveLosses.reduce((total, loss) => total + Math.max(0, loss.recordsInTarget - loss.recordsInBackup), 0);
    const details = destructiveLosses.map((loss) => {
        const records = t('policy.recordDetail', {
            domain: loss.domain,
            backupRecords: loss.recordsInBackup,
            targetRecords: loss.recordsInTarget,
        });
        return loss.globalWouldBeLost ? t('policy.globalLossDetail', { records }) : records;
    }).join('; ');
    throw new Error(t('policy.recordLoss', { recordsLost, details }));
}
export function assertUnknownObjectsAllowed(unknownObjects, allowed, confirmation) {
    if (unknownObjects.length === 0 || (allowed && confirmation === 'REPLACE_DZ23_STORAGE'))
        return;
    throw new Error(t('policy.unknownObjects', { count: unknownObjects.length, objects: unknownObjects.join(', ') }));
}
export function assertForeignInstallationAllowed(backupInstallation, targetInstallation, allowed, confirmation) {
    const isForeign = backupInstallation !== undefined
        && backupInstallation !== null
        && targetInstallation !== undefined
        && targetInstallation !== null
        && backupInstallation !== targetInstallation;
    if (!isForeign || (allowed && confirmation === 'REPLACE_DZ23_STORAGE'))
        return;
    throw new Error(t('policy.foreignInstallation', {
        backupInstallation,
        targetInstallation,
    }));
}
/** Pure process boundary: no connection string is ever an argv item. */
export function postgresDumpInvocation(dsn, schema, ssl, environment = process.env) {
    const target = postgresToolConnection(dsn, ssl, environment);
    // Nada do alvo entra em `argv`: host, porta, usuário e banco viajam no
    // ambiente, decompostos por `postgresToolConnection`, junto com a senha em
    // PGPASSWORD e a política em PGSSLMODE.
    return {
        command: 'pg_dump',
        args: [`--schema=${schema}`, '--format=custom'],
        environment: target.env,
    };
}
