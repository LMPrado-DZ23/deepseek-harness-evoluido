import { readFileSync } from 'node:fs';
const catalog = JSON.parse(readFileSync(new URL('../i18n/pt-BR.json', import.meta.url), 'utf8'));
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
export function t(key, params = {}) {
    const value = catalog[key];
    if (typeof value !== 'string')
        throw new Error(`I18N_KEY_MISSING:${key}`);
    return value.replace(/\{([a-zA-Z0-9_]+)\}/gu, (_match, name) => String(params[name] ?? `{${name}}`));
}
