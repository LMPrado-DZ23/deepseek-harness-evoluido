import { StorageError } from '@deepseek-ai/dsh-storage';
/** Studio-only storage failures that extend the upstream runtime vocabulary. */
export declare class StudioStorageError extends StorageError {
    readonly studioCode: "unit-locked";
    constructor(message: string, options?: ErrorOptions);
}
//# sourceMappingURL=errors.d.ts.map