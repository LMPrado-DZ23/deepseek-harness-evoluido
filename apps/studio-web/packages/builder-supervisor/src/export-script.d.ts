/**
 * O programa do `node -e` para uma raiz e um destino. O teste roda ESTE
 * texto, e não a função: é o texto que o contêiner recebe.
 * @param raiz - de onde exportar.
 * @param destino - para onde.
 * @returns o programa.
 */
export declare function programaDeExportacao(raiz: string, destino: string, manterVivo?: boolean): string;
/**
 * A marca que o exportador escreve quando a cópia TERMINOU.
 *
 * O volume de exportação é `tmpfs`, e um `tmpfs` só existe montado enquanto o
 * contêiner roda: baixar `/export` de um exportador que JÁ SAIU devolve uma
 * pasta vazia. Medido em 20/09/2026 no computador do titular — o leitor
 * recusava na linha "nenhum arquivo", depois de a construção passar em tudo.
 * Por isso o exportador fica vivo depois da cópia, o adaptador espera esta
 * marca, baixa, e só então o para.
 */
export declare const EXPORTACAO_PRONTA = "DZ23_EXPORT_READY";
/** O programa do `node -e` no contêiner de exportação: fica vivo até ser parado. */
export declare const EXPORT_SCRIPT: string;
//# sourceMappingURL=export-script.d.ts.map