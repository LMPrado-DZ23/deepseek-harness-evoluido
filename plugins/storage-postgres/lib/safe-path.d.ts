import type { FileHandle } from 'node:fs/promises';
interface FileIdentity {
    dev: bigint;
    ino: bigint;
}
export interface PinnedDirectory {
    readonly path: string;
    readonly handle: FileHandle;
    readonly identity: FileIdentity;
}
/**
 * Pin a directory and reject symlinks/reparse points in every ancestor. Node
 * has no portable openat(2), so every pathname operation is bracketed by this
 * descriptor identity check. The configured backup directory is private
 * (0700), making replacement by another OS user impossible between checks.
 */
export declare function pinDirectory(path: string, create?: boolean): Promise<PinnedDirectory>;
export declare function assertPinnedDirectory(directory: PinnedDirectory): Promise<void>;
/**
 * Make a directory-entry publication durable where the host exposes directory
 * fsync. Native Windows rejects fsync on directory handles with EPERM/EINVAL;
 * the supported release path runs these operations inside the Linux runtime
 * container, while Windows-side tests still exercise every other invariant.
 */
export declare function syncPinnedDirectory(directory: PinnedDirectory): Promise<void>;
export declare function childPath(directory: PinnedDirectory, name: string): string;
/**
 * Path used for the actual syscall. Linux resolves the child through the
 * already-open directory descriptor, which is openat-equivalent and remains
 * confined even if the configured pathname is renamed concurrently. Windows
 * has no `/proc/self/fd`; there the pinned identity plus private ACL boundary
 * is rechecked around every operation.
 */
export declare function pinnedChildPath(directory: PinnedDirectory, name: string): string;
export declare function openNewPinnedFile(directory: PinnedDirectory, name: string, mode?: number): Promise<FileHandle>;
/** New private regular file that can be hashed through the creating descriptor. */
export declare function openNewPinnedReadWriteFile(directory: PinnedDirectory, name: string, mode?: number): Promise<FileHandle>;
export declare function openPinnedAppendFile(directory: PinnedDirectory, name: string, mode?: number): Promise<FileHandle>;
export declare function pinParent(path: string, create?: boolean): Promise<{
    directory: PinnedDirectory;
    name: string;
}>;
export {};
//# sourceMappingURL=safe-path.d.ts.map