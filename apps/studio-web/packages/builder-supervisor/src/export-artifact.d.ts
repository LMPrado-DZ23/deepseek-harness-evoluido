import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { ExportedArtifact } from './model.js';
export interface ExportRuntime {
    readonly lstat: typeof lstat;
    readonly mkdir: typeof mkdir;
    readonly open: typeof open;
    readonly readdir: typeof readdir;
    readonly realpath: typeof realpath;
    readonly rename: typeof rename;
    readonly remove: typeof rm;
    readonly writeFile: typeof writeFile;
    readonly noFollowFlag: number;
    readonly platform: NodeJS.Platform;
    readonly uid: number | undefined;
    readonly randomHex: () => string;
}
export interface ManagedExportArchive {
    readonly path: string;
    readonly handle: FileHandle;
    readonly dev: number;
    readonly ino: number;
}
export interface ExpectedArchive {
    readonly dev: number;
    readonly ino: number;
    readonly size: number;
    readonly sha256: string;
}
export declare function currentExportIdentity(platform: NodeJS.Platform, getuid: (() => number) | undefined): Pick<ExportRuntime, 'platform' | 'uid'>;
export declare function openManagedExportArchive(exportRoot: string, buildRef: string, runtime?: ExportRuntime): Promise<ManagedExportArchive>;
export declare function readValidatedPublishedArtifact(exportRoot: string, buildRef: string, runtime?: ExportRuntime): Promise<ExportedArtifact | undefined>;
export declare function listManagedExportArchives(exportRoot: string, runtime?: ExportRuntime): Promise<readonly string[]>;
export declare function cleanupManagedExportResources(exportRoot: string, buildRef: string | undefined, signal: AbortSignal, runtime?: ExportRuntime): Promise<void>;
export declare function publishValidatedDockerArchive(exportRoot: string, buildRef: string, archivePath: string, signal: AbortSignal, runtime?: ExportRuntime, expected?: ExpectedArchive): Promise<ExportedArtifact>;
export declare function enforceExportRetention(exportRoot: string, currentBuildRef: string, pinnedBuildRefs: ReadonlySet<string>, maximumExports: number, maximumBytes: number, signal: AbortSignal, runtime?: ExportRuntime): Promise<void>;
/**
 * O NOME de um cabeçalho PAX, e só ele. Qualquer outra chave que mude o
 * sentido da entrada seguinte (`size`, `linkpath`, esparsos do GNU…) é
 * recusa: aceitá-la desalinharia a leitura ou traria um link por outra porta.
 * @param corpo - os registros `<tamanho> <chave>=<valor>\n`.
 * @returns o caminho, ou `undefined` quando o cabeçalho só traz metadados
 *   (a data com fração de segundo, por exemplo) e o nome vem do ustar.
 */
export declare function paxPathOf(corpo: Buffer): string | undefined;
export declare function assertExportPathBeneath(root: string, path: string): void;
//# sourceMappingURL=export-artifact.d.ts.map