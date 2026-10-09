import { lstatSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { ArtifactIngressPort } from './artifact-ingress.js';
import type { BuilderRpcMethods } from './protocol.js';
import { type BuilderRuntimeScopeId } from './runtime-scope.js';
interface LifecycleMethods extends BuilderRpcMethods {
    initialize?(signal: AbortSignal): Promise<void>;
}
export declare class BuilderUnixListenerCleanupError extends Error {
    readonly code = "LISTENER_CLEANUP_INCOMPLETE";
    constructor();
}
/**
 * A identidade de um socket no disco.
 *
 * `(dev, ino)` NAO e identidade: e endereco, e endereco e reciclavel. O ext4
 * devolve o inode liberado ao proximo `bind()` no mesmo diretorio, entao um
 * socket ESTRANGEIRO criado logo depois do nosso fechar nasce com exatamente o
 * mesmo par - passa em qualquer verificacao que so olhe dev e ino, e o
 * supervisor apaga o socket de outra pessoa achando que apaga o seu.
 *
 * Medido: 150 de 150 fechamentos reciclaram o inode; com uma alocacao
 * intercalada roubando o inode, 50 de 50 foram recusados corretamente. O que
 * decidia o resultado nao era o tempo - era a disputa por inode no grupo de
 * blocos, e e por isso que o defeito aparecia "sob carga".
 *
 * `birthtimeNs` (crtime do ext4) e o discriminador que o inode nao carrega: nos
 * 60 casos de reuso medidos ele diferiu sempre, por milissegundos. Onde o
 * sistema de arquivos nao oferecer crtime, o valor vem zero e a verificacao
 * degrada para o comportamento antigo - o que nao piora nada, e deixa o ganho
 * onde ele existe.
 */
export interface SocketIdentity {
    readonly dev: number;
    readonly ino: number;
    readonly birthtimeNs: bigint;
}
export interface BuilderUnixRuntime {
    readonly platform: NodeJS.Platform;
    readonly pid: number;
    readonly getuid: (() => number) | undefined;
    readonly kill: typeof process.kill;
    readonly umask: typeof process.umask;
    readonly lstatSync: typeof lstatSync;
    readonly chmod: typeof chmod;
    readonly lstat: typeof lstat;
    readonly mkdir: typeof mkdir;
    readonly open: typeof open;
    readonly readFile: typeof readFile;
    readonly realpath: typeof realpath;
    readonly rename: typeof rename;
    readonly remove: typeof rm;
    readonly unlink: typeof unlink;
    readonly writeFile: typeof writeFile;
    readonly createServer: typeof createServer;
    readonly request: typeof httpRequest;
    readonly setTimeout: typeof setTimeout;
    readonly clearTimeout: typeof clearTimeout;
}
export interface BuilderUnixServerOptions {
    readonly socketPath: string;
    readonly bearerToken: string;
    readonly methods: LifecycleMethods;
    readonly scopeId: BuilderRuntimeScopeId;
    readonly policySha256: string;
    readonly replayRoot: string;
    readonly artifactIngress?: ArtifactIngressPort;
    readonly signal?: AbortSignal;
    readonly operationTimeoutMs?: number;
    readonly artifactTimeoutMs?: number;
    readonly stepTimeoutMs?: number;
    readonly cleanupTimeoutMs?: number;
    readonly runtime?: BuilderUnixRuntime;
}
export declare function listenBuilderUnix(options: BuilderUnixServerOptions): Promise<{
    readonly server: Server;
    close(afterStopAccepting?: () => void): Promise<void>;
}>;
export {};
//# sourceMappingURL=unix-server.d.ts.map