import type { FileHandle } from 'node:fs/promises';
import type { DockerEnginePort } from './docker-engine.js';
import { cleanupManagedExportResources } from './export-artifact.js';
import type { BuilderAttestation, BuildStep, ExportedArtifact, StepResult } from './model.js';
import { type BuilderRuntimeScopeId } from './runtime-scope.js';
export interface BuilderLimits {
    readonly memoryBytes: number;
    readonly nanoCpus: number;
    readonly pids: number;
    readonly timeoutMs: number;
    readonly workspaceBytes: number;
    readonly maxWorkspaceBytes: number;
    readonly concurrentContainers: number;
    readonly maxExportBytes: number;
    readonly maxRetainedExports: number;
}
export interface DockerBuilderAdapterOptions {
    readonly engine: DockerEnginePort;
    readonly imageDigest: `sha256:${string}`;
    readonly installationId: string;
    readonly scopeId: BuilderRuntimeScopeId;
    readonly exportRoot: string;
    readonly templateStoreVersion: string;
    readonly templateStoreSha256: string;
    readonly limits?: BuilderLimits;
    /** @internal Deterministic filesystem fault seam; production uses node:fs/promises.rm. */
    readonly removeArchive?: (path: string) => Promise<void>;
    /** @internal Deterministic export-garbage fault seam. */
    readonly cleanupExportResources?: typeof cleanupManagedExportResources;
    /** @internal Deterministic descriptor-close fault seam. */
    readonly closeArchive?: (handle: FileHandle) => Promise<void>;
    /** @internal O relógio da reconferência do store (ver `STORE_REVERIFY_MS`). */
    readonly now?: () => number;
    /**
     * POR QUE uma exportação falhou, para o registro de quem opera.
     *
     * O diário guarda só o código (`EXPORT_INVALID`), e o código cobria uma
     * dúzia de causas diferentes. Medido em 20/09/2026: duas criações que
     * passaram em tudo pararam aqui, e nada dizia em qual passo. O evento leva
     * a ETAPA e, quando o exportador saiu com erro, o fim da saída de erro DELE
     * — que é o nosso programa falando, e não o aplicativo nem um segredo.
     */
    readonly diagnostico?: (evento: Readonly<Record<string, string | number>>) => void;
}
/**
 * De quanto em quanto tempo o `preflight` refaz a conferência COMPLETA do store.
 *
 * A conferência completa baixa o volume inteiro e confere cada arquivo por
 * hash. Com o dublê de teste (um arquivo) ela era instantânea; com o store REAL
 * (23.346 entradas, 560 MB) ela leva minutos — medido em 19/09/2026. E o
 * `preflight` é o que a tela de saúde pergunta a cada consulta: a resposta
 * nunca chegava a tempo, e a tela dizia "ambiente isolado indisponível" com o
 * construtor de pé.
 *
 * Entre uma conferência completa e a próxima, o que se confere é o MESMO
 * volume: mesmo nome e mesma data de criação. Um volume trocado (apagado e
 * recriado) tem outra data e força a conferência completa na hora. O que fica
 * de fora nessa janela é alteração do conteúdo sem recriar o volume — o que
 * exige root no daemon, e contra quem tem root no daemon nenhuma conferência
 * daqui protege. Os builds montam o volume SÓ LEITURA.
 */
export declare const STORE_REVERIFY_MS: number;
/** O prazo de UMA conferência completa do store, independente de quem pergunta. */
export declare const STORE_VERIFY_TIMEOUT_MS: number;
export interface PreparedArtifact {
    readonly archivePath: string;
    readonly archiveHandle?: FileHandle;
    readonly archiveBytes: number;
    readonly sha256: string;
    readonly files: number;
    readonly bytes: number;
}
export interface RecoveredBuild {
    readonly build_ref: string;
    readonly build_id: string;
}
export interface BuilderExecutionPort {
    preflight(signal: AbortSignal): Promise<BuilderAttestation>;
    reconcile(expected: readonly RecoveredBuild[], signal: AbortSignal): Promise<readonly RecoveredBuild[]>;
    prepare(buildRef: string, buildId: string, artifact: PreparedArtifact, signal: AbortSignal): Promise<void>;
    execute(buildRef: string, step: BuildStep, signal: AbortSignal): Promise<StepResult>;
    cancel(buildRef: string, signal: AbortSignal): Promise<void>;
    exportArtifact(buildRef: string, signal: AbortSignal): Promise<ExportedArtifact>;
    commitArtifact(buildRef: string, pinnedBuildRefs: ReadonlySet<string>, signal: AbortSignal): Promise<void>;
    cleanup(buildRef: string, signal: AbortSignal): Promise<void>;
    listManaged(signal: AbortSignal): Promise<readonly string[]>;
}
/** Os limites que o adaptador aplica quando ninguém declarou outros. */
export declare const DEFAULT_BUILDER_LIMITS: BuilderLimits;
/**
 * O hash da POLÍTICA de construção — imagem, escopo, store, comandos, limites e
 * as restrições do contêiner.
 *
 * Ele é FUNÇÃO EXPORTADA, e não conta feita dentro do construtor, porque tem
 * DOIS consumidores que precisam chegar ao mesmo número: o adaptador, que o
 * atesta a cada execução, e o instalador, que o grava na configuração
 * provisionada. A atestação compara os dois (`supervisor-main.ts`) e reprova
 * com `BUILDER_ATTESTATION_FAILED` quando divergem. Uma segunda cópia desta
 * conta no instalador seria a segunda verdade mais cara possível: ela
 * concordaria com esta até o dia em que alguém mudasse um comando ou um limite
 * aqui — e aí toda construção seria recusada, com o instalador jurando que
 * provisionou certo.
 * @param input - o que a política amarra.
 * @returns o SHA-256 em hexadecimal.
 */
export declare function builderPolicySha256(input: {
    readonly imageDigest: string;
    readonly scopeId: string;
    readonly templateStoreVersion: string;
    readonly templateStoreSha256: string;
    readonly limits?: BuilderLimits;
}): string;
export declare class DockerBuilderAdapter implements BuilderExecutionPort {
    #private;
    private readonly options;
    constructor(options: DockerBuilderAdapterOptions);
    preflight(signal: AbortSignal): Promise<BuilderAttestation>;
    reconcile(expected: readonly RecoveredBuild[], signal: AbortSignal): Promise<readonly RecoveredBuild[]>;
    prepare(buildRef: string, buildId: string, artifact: PreparedArtifact, signal: AbortSignal): Promise<void>;
    execute(buildRef: string, step: BuildStep, signal: AbortSignal): Promise<StepResult>;
    cancel(buildRef: string, signal: AbortSignal): Promise<void>;
    exportArtifact(buildRef: string, signal: AbortSignal): Promise<ExportedArtifact>;
    commitArtifact(buildRef: string, pinnedBuildRefs: ReadonlySet<string>, signal: AbortSignal): Promise<void>;
    cleanup(buildRef: string, signal: AbortSignal): Promise<void>;
    listManaged(signal: AbortSignal): Promise<readonly string[]>;
}
/**
 * O endurecimento do contêiner do construtor, em UM lugar (S-15).
 *
 * Exportado para a PROVA poder consumir exatamente este objeto em vez de
 * redigitar as opções: uma prova que reescreve os argumentos prova a cópia
 * dela, e não o que o produto manda para o Docker — foi assim que
 * `deny: ['network']` sobreviveu no A-06.
 */
export declare function hardenedHost(limits: BuilderLimits, mounts: readonly unknown[]): Readonly<Record<string, unknown>>;
/**
 * A linha que RECUSOU, tirada da pilha do erro: o leitor do arquivo recusa
 * em trinta lugares com o mesmo código, e o código sozinho não diz qual.
 * Só arquivo e linha do nosso próprio código — nenhum conteúdo.
 * @param error - o erro.
 * @returns `arquivo.js:linha`, ou vazio.
 */
export declare function ondeRecusou(error: unknown): string;
/**
 * Espera o exportador terminar a CÓPIA sem deixá-lo sair (ver
 * `EXPORTACAO_PRONTA`): a pasta de exportação some quando ele sai.
 *
 * Sair antes da marca é falha, mesmo com código 0 — era exatamente o caso
 * que devolvia uma pasta vazia. A resposta usa a forma de `waitContainer` para
 * o resto do adaptador não mudar: `StatusCode` 0 quer dizer "pronto, e vivo".
 * @param engine - o motor.
 * @param exportador - o contêiner.
 * @param signal - o cancelamento.
 * @returns 0 quando pronto; o código de saída (ou -1) quando saiu antes.
 */
export declare function esperarExportacao(engine: Pick<DockerEnginePort, 'waitContainer' | 'containerLogs'>, exportador: string, signal: AbortSignal, intervaloMs?: number): Promise<{
    readonly StatusCode: number;
}>;
//# sourceMappingURL=docker-adapter.d.ts.map