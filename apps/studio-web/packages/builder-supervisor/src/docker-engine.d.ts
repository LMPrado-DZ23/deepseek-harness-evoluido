import type { FileHandle } from 'node:fs/promises';
import { open, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
export interface DockerEnginePort {
    ping(signal: AbortSignal): Promise<void>;
    inspectImage(digest: string, signal: AbortSignal): Promise<{
        readonly Id: string;
    }>;
    createVolume(name: string, labels: Readonly<Record<string, string>>, driverOpts: Readonly<Record<string, string>>, signal: AbortSignal): Promise<void>;
    removeVolume(name: string, signal: AbortSignal): Promise<void>;
    listVolumes(filters: Readonly<Record<string, readonly string[]>>, signal: AbortSignal): Promise<readonly Record<string, unknown>[]>;
    createContainer(name: string, body: unknown, signal: AbortSignal): Promise<string>;
    putArchive(container: string, destination: string, archivePath: string, maximumBytes: number, signal: AbortSignal): Promise<void>;
    putArchiveHandle?(container: string, destination: string, archiveHandle: FileHandle, maximumBytes: number, signal: AbortSignal): Promise<void>;
    startContainer(id: string, signal: AbortSignal): Promise<void>;
    waitContainer(id: string, signal: AbortSignal): Promise<{
        readonly StatusCode: number;
    }>;
    /**
     * Os registros do contêiner. Por padrão ACOMPANHA (`follow=1`): a resposta só
     * termina quando o contêiner sai — é o que quem espera o fim de um passo
     * quer. `acompanhar: false` devolve o que há AGORA, para quem sonda um
     * contêiner que deve continuar vivo (o exportador).
     */
    containerLogs(id: string, maximumBytes: number, signal: AbortSignal, opcoes?: {
        readonly acompanhar?: boolean;
    }): Promise<{
        readonly stdout: Buffer;
        readonly stderr: Buffer;
    }>;
    downloadArchive(container: string, source: string, destination: FileHandle, maximumBytes: number, signal: AbortSignal): Promise<{
        readonly bytes: number;
        readonly sha256: string;
    }>;
    stopContainer(id: string, signal: AbortSignal): Promise<void>;
    removeContainer(id: string, signal: AbortSignal): Promise<void>;
    listContainers(filters: Readonly<Record<string, readonly string[]>>, signal: AbortSignal): Promise<readonly Record<string, unknown>[]>;
}
export interface DockerEngineRuntime {
    readonly request: typeof httpRequest;
    readonly open: typeof open;
    readonly remove: typeof rm;
    readonly noFollowFlag: number;
}
export declare class DockerEngine implements DockerEnginePort {
    #private;
    private readonly socketPath;
    private readonly requestTimeoutMs;
    private readonly runtime;
    constructor(socketPath: string, requestTimeoutMs?: number, runtime?: DockerEngineRuntime);
    ping(signal: AbortSignal): Promise<void>;
    inspectImage(digest: string, signal: AbortSignal): Promise<{
        readonly Id: string;
    }>;
    createVolume(name: string, labels: Readonly<Record<string, string>>, driverOpts: Readonly<Record<string, string>>, signal: AbortSignal): Promise<void>;
    removeVolume(name: string, signal: AbortSignal): Promise<void>;
    listVolumes(filters: Readonly<Record<string, readonly string[]>>, signal: AbortSignal): Promise<readonly Record<string, unknown>[]>;
    createContainer(name: string, body: unknown, signal: AbortSignal): Promise<string>;
    putArchive(container: string, destination: string, archivePath: string, maximumBytes: number, signal: AbortSignal): Promise<void>;
    putArchiveHandle(container: string, destination: string, archiveHandle: FileHandle, maximumBytes: number, signal: AbortSignal): Promise<void>;
    startContainer(id: string, signal: AbortSignal): Promise<void>;
    waitContainer(id: string, signal: AbortSignal): Promise<{
        readonly StatusCode: number;
    }>;
    containerLogs(id: string, maximumBytes: number, signal: AbortSignal, opcoes?: {
        readonly acompanhar?: boolean;
    }): Promise<{
        readonly stdout: Buffer;
        readonly stderr: Buffer;
    }>;
    downloadArchive(container: string, source: string, handle: FileHandle, maximumBytes: number, signal: AbortSignal): Promise<{
        readonly bytes: number;
        readonly sha256: string;
    }>;
    stopContainer(id: string, signal: AbortSignal): Promise<void>;
    removeContainer(id: string, signal: AbortSignal): Promise<void>;
    listContainers(filters: Readonly<Record<string, readonly string[]>>, signal: AbortSignal): Promise<readonly Record<string, unknown>[]>;
}
export declare function demultiplexDockerStream(value: Buffer, maximum?: number): {
    readonly stdout: Buffer;
    readonly stderr: Buffer;
};
//# sourceMappingURL=docker-engine.d.ts.map