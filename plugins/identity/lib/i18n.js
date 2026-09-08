import { readFileSync } from 'node:fs';
const catalog = JSON.parse(readFileSync(new URL('../i18n/pt-BR.json', import.meta.url), 'utf8'));
export function t(key) {
    const value = catalog[key];
    if (typeof value !== 'string')
        throw new Error(`I18N_KEY_MISSING:${key}`);
    return value;
}
