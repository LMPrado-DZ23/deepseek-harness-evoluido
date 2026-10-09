import { type FileHandle } from 'node:fs/promises';
import type { DockerEnginePort } from './docker-engine.js';
import { type BuilderRuntimeScopeId } from './runtime-scope.js';
import { type TemplateStoreManifest } from './store-security.js';
export declare const TEMPLATE_STORE_VERIFICATION_TIMEOUT_MS: number;
export declare const TEMPLATE_STORE_VERIFICATION_CLEANUP_BUDGET_MS: number;
export declare const TEMPLATE_STORE_CLAIM_TTL_MS: number;
export type TemplateStoreVolumeErrorCode = 'TEMPLATE_STORE_ABORTED' | 'TEMPLATE_STORE_BUSY' | 'TEMPLATE_STORE_CLEANUP_INCOMPLETE' | 'TEMPLATE_STORE_INVALID' | 'TEMPLATE_STORE_TARGET_MISMATCH';
export declare class TemplateStoreVolumeError extends Error {
    readonly code: TemplateStoreVolumeErrorCode;
    constructor(code: TemplateStoreVolumeErrorCode);
}
export interface TemplateStoreVolumeIdentity {
    readonly installationId: string;
    readonly scopeId: BuilderRuntimeScopeId;
    readonly version: string;
    readonly treeSha256: string;
}
export interface TemplateStoreVolumeOptions extends TemplateStoreVolumeIdentity {
    readonly engine: DockerEnginePort;
    readonly imageDigest: `sha256:${string}`;
    readonly sourceEnvelope: string;
    readonly manifest: TemplateStoreManifest;
}
export interface TemplateStoreVolumeResult {
    readonly state: 'CREATED' | 'REUSED';
    readonly volumeName: string;
    readonly treeSha256: string;
}
export declare function ensureTemplateStoreVolume(options: TemplateStoreVolumeOptions, signal: AbortSignal): Promise<TemplateStoreVolumeResult>;
export interface VerifyTemplateStoreVolumeOptions extends TemplateStoreVolumeIdentity {
    readonly engine: DockerEnginePort;
    readonly imageDigest: `sha256:${string}`;
    readonly volumeName?: string;
}
export declare function verifyTemplateStoreVolume(options: VerifyTemplateStoreVolumeOptions, signal: AbortSignal): Promise<boolean>;
export declare function templateStoreVolumeName(installationId: string, scopeId: BuilderRuntimeScopeId, version: string, treeSha256: string): string;
export declare function templateStoreVolumeLabels(inputValue: TemplateStoreVolumeIdentity): Readonly<Record<string, string>>;
export declare function templateStoreUstarEntryPath(value: unknown): string;
export declare function hasExactIdentity(row: unknown, expected: Readonly<Record<string, string>>): boolean;
export declare function templateStoreTransporterBody(image: `sha256:${string}`, identity: TemplateStoreVolumeIdentity, volume: string, readOnly: boolean): Readonly<Record<string, unknown>>;
export declare function validateTemplateStoreArchive(handle: Pick<FileHandle, 'read'>, size: number, version: string, treeSha256: string, empty: boolean, signal: AbortSignal): Promise<boolean>;
/**
 * Um registro PAX: `<tamanho> <chave>=<valor>\n`, onde o tamanho conta os
 * próprios dígitos — por isso o laço até o número parar de mudar.
 * @param key - a chave.
 * @param value - o valor.
 * @returns o registro.
 */
export declare function paxRecord(key: string, value: string): string;
/**
 * O caminho de um cabeçalho PAX — e NADA além dele.
 *
 * Só `path` muda a entrada seguinte; os tempos são aceitos e ignorados, porque
 * o conteúdo é conferido por hash e não por data. Qualquer outra chave (dono,
 * tamanho, link) recusa: ela mudaria o que a entrada É sem passar pelas
 * conferências do cabeçalho comum.
 * @param content - o corpo do cabeçalho PAX.
 * @returns o caminho.
 */
export declare function paxRecordPath(content: Buffer): string;
export declare function streamTemplateStoreFile(handle: Pick<FileHandle, 'read'>, size: number, signal: AbortSignal, consume?: (value: Buffer) => Promise<void>): Promise<{
    readonly bytes: number;
    readonly sha256: string;
}>;
export declare function writeTemplateStoreBytes(handle: Pick<FileHandle, 'write'>, value: Buffer): Promise<number>;
export declare function validateTemplateStoreEntryCount(count: number): void;
//# sourceMappingURL=template-store-volume.d.ts.map