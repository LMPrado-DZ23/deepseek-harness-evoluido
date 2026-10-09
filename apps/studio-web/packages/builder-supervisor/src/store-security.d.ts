import { type KeyObject } from 'node:crypto';
import type { Stats } from 'node:fs';
export declare const TEMPLATE_MANIFEST_MAX_BYTES: number;
export declare const TEMPLATE_ENTRY_MAX_BYTES: number;
export declare const TEMPLATE_STORE_MAX_BYTES: number;
export declare const TEMPLATE_STORE_MAX_ENTRIES = 60000;
export type TemplateManifestEntry = {
    readonly path: string;
    readonly type: 'directory';
} | {
    readonly path: string;
    readonly type: 'file';
    readonly bytes: number;
    readonly sha256: string;
};
export interface TemplateStoreManifest {
    readonly version: 1;
    readonly template_store_version: string;
    readonly tree_sha256: string;
    readonly entries: readonly TemplateManifestEntry[];
    /**
     * Assinatura Ed25519 (base64) sobre os bytes canônicos do manifesto SEM ela.
     *
     * OPCIONAL, e a versão do manifesto NÃO sobe: um armazenamento provisionado
     * antes de a assinatura existir continua legível, e a versão é comparada
     * byte a byte em três lugares — subi-la recusaria toda instalação existente.
     * Ausente significa NÃO ASSINADO, e nunca "assinado por alguém que não
     * conferimos": o veredito viaja em `templateStoreSignatureVerdict`.
     *
     * **HOJE NINGUÉM CONSULTA ESSE VEREDITO.** Uma revisão adversarial apontou,
     * com razão, que `templateStoreSignatureVerdict` não tem chamador em
     * produção: nenhuma chave de publicador é configurada em lugar nenhum, e
     * `supervisor-config.ts` confere bytes canônicos, versão e `tree_sha256` —
     * integridade, não ORIGEM. Na prática, um manifesto sem assinatura e um
     * assinado por qualquer pessoa são aceitos do mesmo jeito, e a única barreira
     * de origem que sobra é o `--manifest-sha256` digitado à mão na CLI.
     *
     * Isto está escrito aqui porque quem ler este arquivo precisa saber o que ele
     * AINDA NÃO protege. Ligar a conferência exige custódia de uma chave privada
     * de publicação — decisão do Prado, a mesma dependência do P-02 — e uma
     * versão nova do envelope de configuração; está registrado em EB-08 e T-31,
     * e o veredito NÃO foi removido porque a capacidade é desenhada e correta,
     * só não tem chave.
     */
    readonly signature?: string;
}
/**
 * Os bytes que são ASSINADOS: o manifesto sem a assinatura.
 *
 * A assinatura fica fora do que ela cobre por necessidade — assinar um
 * documento que já contém a própria assinatura é impossível — e essa exclusão
 * é a razão de existirem duas formas canônicas neste arquivo.
 * @param value - o manifesto.
 * @returns os bytes canônicos, sem assinatura.
 */
export declare function canonicalTemplateStoreManifestBytes(value: unknown): Buffer;
/**
 * A forma canônica DE DISCO: a mesma, com a assinatura no fim quando existe.
 *
 * É esta que é comparada com o arquivo lido e é esta que entra no hash da
 * autoridade — senão um armazenamento poderia perder a assinatura sem que o
 * hash gravado mudasse.
 * @param value - o manifesto.
 * @returns os bytes canônicos do arquivo.
 */
export declare function canonicalSignedTemplateStoreManifestBytes(value: unknown): Buffer;
export declare function parseTemplateStoreManifest(value: unknown): TemplateStoreManifest;
export declare class TemplateSigningError extends Error {
    readonly code: 'KEY_INVALID' | 'ALREADY_SIGNED';
    constructor(code: 'KEY_INVALID' | 'ALREADY_SIGNED', message: string);
}
/**
 * Assina um manifesto de armazenamento de template.
 *
 * A chave privada é passada, usada uma vez e descartada: ela nunca mora neste
 * repositório, e é isso que separa "o produto sabe assinar" de "o produto
 * carrega a chave de assinar".
 * @param manifest - o manifesto a assinar.
 * @param privateKey - a chave Ed25519, em PEM PKCS#8.
 * @param options.replace - reassinar um manifesto que já tem assinatura.
 * @returns o manifesto com assinatura.
 */
export declare function signTemplateStoreManifest(manifest: unknown, privateKey: string | KeyObject, options?: {
    readonly replace?: boolean;
}): TemplateStoreManifest;
/**
 * O veredito da assinatura de um armazenamento de template.
 *
 * `UNSIGNED` é um estado próprio, e não uma reprovação: uma instalação
 * provisionada antes de a assinatura existir não é um ataque. O que ele NÃO
 * pode virar é "assinado" — quem lê este veredito é quem decide se aceita um
 * armazenamento sem prova de origem.
 */
export type TemplateSignatureVerdict = {
    readonly state: 'UNSIGNED';
} | {
    readonly state: 'SIGNED';
    readonly publisher: string;
} | {
    readonly state: 'INVALID_SIGNATURE';
} | {
    readonly state: 'UNKNOWN_PUBLISHER';
};
/**
 * Confere a assinatura contra as chaves públicas confiadas.
 *
 * @param manifest - o manifesto lido do disco.
 * @param publisherKeys - id do publicador → chave pública Ed25519 (SPKI base64).
 * @returns o veredito.
 */
export declare function templateStoreSignatureVerdict(manifest: unknown, publisherKeys: Readonly<Record<string, string>>): TemplateSignatureVerdict;
export declare function checkedTemplateStoreByteTotal(current: number, added: number): number;
export declare function checkedTemplateStoreEntryCount(count: number): number;
export declare function computeTemplateTreeSha256(version: string, entries: readonly TemplateManifestEntry[]): string;
export declare function canonicalSourceRoot(value: string): string;
export declare function manifestReferencePath(value: string): string;
export declare function provisionIdentifier(value: string): string;
export declare function templateVersion(value: string): string;
export declare function sha256Value(value: string): string;
export declare function imageDigestValue(value: string): `sha256:${string}`;
export declare function assertSafeStoreStat(stat: Stats, expected: 'directory' | 'file', sealed: boolean): void;
export declare function assertSourceIdentity(opened: Stats, linked: Stats, expected: 'directory' | 'file'): void;
export declare function assertUnchangedStoreStat(left: Stats, right: Stats, expected: 'directory' | 'file'): void;
export declare function isSafeStagingName(value: string): boolean;
export declare function templateEntryPath(value: unknown): string;
//# sourceMappingURL=store-security.d.ts.map