/**
 * Texto do catálogo, com substituição de `{campo}`.
 *
 * Um campo ausente aparece como `{campo}` em vez de sumir: um buraco visível é
 * melhor do que uma frase que perde a informação sem ninguém notar. Uma CHAVE
 * ausente é erro, e não texto vazio na cara da pessoa.
 * @param key - chave do catálogo.
 * @param params - valores a substituir na frase.
 * @returns o texto pronto.
 */
export declare function t(key: string, params?: Readonly<Record<string, string | number>>): string;
//# sourceMappingURL=i18n.d.ts.map