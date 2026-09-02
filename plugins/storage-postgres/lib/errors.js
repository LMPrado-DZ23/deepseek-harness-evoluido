import { StorageError } from '@deepseek-ai/dsh-storage';
/** Studio-only storage failures that extend the upstream runtime vocabulary. */
export class StudioStorageError extends StorageError {
    studioCode = 'unit-locked';
    constructor(message, options) {
        super('closed', message, options);
        // The upstream union cannot be widened out of tree. Keep inheritance for
        // callers that already handle StorageError and expose the stable Studio
        // discriminant at runtime until the upstream vocabulary accepts it.
        Object.defineProperty(this, 'code', {
            configurable: false,
            enumerable: true,
            value: 'unit-locked',
            writable: false,
        });
        Object.defineProperty(this, 'name', {
            configurable: true,
            value: 'StudioStorageError',
        });
    }
}
