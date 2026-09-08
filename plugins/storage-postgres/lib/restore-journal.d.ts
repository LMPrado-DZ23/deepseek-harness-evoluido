export type RestoreJournalState = 'verified' | 'safety_published' | 'staging_created' | 'staged_verified' | 'swap_started' | 'committed' | 'cleanup_complete';
export interface RestoreJournal {
    v: 1;
    attemptId: string;
    targetSchema: string;
    targetFingerprint: string;
    inputSha256: string;
    safetyDestination: string;
    state: RestoreJournalState;
    stagingSchema: string | null;
    safety: {
        path: string;
        sha256: string;
        bytes: number;
    } | null;
    result: Record<string, unknown> | null;
    updatedAt: string;
}
export declare function journalReached(current: RestoreJournal, state: RestoreJournalState): boolean;
export declare function assertJournalIdentity(journal: RestoreJournal, expected: Pick<RestoreJournal, 'attemptId' | 'targetSchema' | 'targetFingerprint' | 'inputSha256' | 'safetyDestination'>): void;
export declare function advanceJournal(current: RestoreJournal, state: RestoreJournalState, patch?: Partial<Pick<RestoreJournal, 'stagingSchema' | 'safety' | 'result'>>): RestoreJournal;
export declare function loadRestoreJournal(path: string): Promise<RestoreJournal | undefined>;
export declare function writeRestoreJournal(path: string, journal: RestoreJournal): Promise<void>;
/**
 * Claim one instance-scoped attempt without replacing a journal another
 * PostgreSQL database may have created concurrently. The permanent path is the
 * serialization point; callers must reload and compare its identity when this
 * returns false.
 */
export declare function reserveRestoreJournal(path: string, journal: RestoreJournal): Promise<boolean>;
//# sourceMappingURL=restore-journal.d.ts.map