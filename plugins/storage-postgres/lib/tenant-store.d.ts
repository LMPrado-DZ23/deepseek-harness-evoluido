export interface TenantScope {
    readonly orgId: string;
    readonly tenantId: string;
}
export interface TenantRecord<T = unknown> {
    readonly key: string;
    readonly value: T;
}
export interface PostgresTenantStoreConfig {
    readonly adminConnectionString: string;
    readonly runtimeConnectionString: string;
    readonly schema: string;
    readonly ssl: false | {
        rejectUnauthorized: boolean;
    };
    readonly poolMax: number;
}
/**
 * A tenant-aware repository that never accepts scope from stored JSON. Every
 * operation opens one transaction and installs the server-derived scope with
 * transaction-local PostgreSQL settings before touching the RLS table.
 */
export declare class PostgresTenantRecordStore {
    private readonly pool;
    private readonly schemaName;
    private closing;
    private constructor();
    static create(config: PostgresTenantStoreConfig): Promise<PostgresTenantRecordStore>;
    list<T = unknown>(scope: TenantScope, unit: string, table: string): Promise<readonly TenantRecord<T>[]>;
    get<T = unknown>(scope: TenantScope, unit: string, table: string, key: string): Promise<T | undefined>;
    put(scope: TenantScope, unit: string, table: string, key: string, value: unknown): Promise<void>;
    /**
     * Grava SE a linha ainda estiver como quem escreve viu — no banco, e não no
     * processo.
     *
     * Existe por um buraco concreto e nomeado: a autoridade de confirmação de
     * ações sensíveis marcava uma confirmação como consumida lendo e escrevendo
     * em duas idas ao banco, serializadas por um mutex EM MEMÓRIA. Instância
     * única, tudo bem. Com duas réplicas — ou um segundo processo qualquer —, as
     * duas leem `AVAILABLE`, as duas escrevem `CONSUMED` com reivindicações
     * DIFERENTES, e a segunda escrita passa por cima da primeira: UMA
     * confirmação humana autorizando DUAS execuções distintas. É o oposto exato
     * do que uma confirmação de uso único significa.
     *
     * Aqui a condição vai DENTRO da instrução. `ON CONFLICT DO UPDATE` toma a
     * trava da linha antes de avaliar o `WHERE`, então a comparação é contra o
     * estado atual e não contra o que foi lido antes. Quem perde escreve zero
     * linhas e descobre pelo retorno.
     *
     * O campo comparado viaja como PARÂMETRO (`value ->> $n`), e não interpolado:
     * nome de campo vindo de quem chama nunca entra no texto da consulta.
     * @param scope - organização e inquilino.
     * @param unit - a unidade lógica.
     * @param table - a tabela lógica.
     * @param key - a chave do registro.
     * @param value - o valor a gravar.
     * @param expected - `'absent'` para exigir que a linha não exista, ou o campo
     *   e o valor que a linha atual precisa ter.
     * @returns verdadeiro quando gravou; falso quando a condição não valia.
     */
    putIf(scope: TenantScope, unit: string, table: string, key: string, value: unknown, expected: 'absent' | {
        readonly field: string;
        readonly value: string;
    }): Promise<boolean>;
    delete(scope: TenantScope, unit: string, table: string, key: string): Promise<boolean>;
    close(): Promise<void>;
    private withScope;
    private verifyRuntimeBoundary;
}
//# sourceMappingURL=tenant-store.d.ts.map