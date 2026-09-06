import { readFileSync } from 'node:fs';
const catalog = JSON.parse(readFileSync(new URL('../i18n/pt-BR.json', import.meta.url), 'utf8'));
export function t(key, params = {}) {
    const value = key.split('.').reduce((current, part) => {
        return typeof current === 'object' && current !== null ? current[part] : undefined;
    }, catalog);
    if (typeof value !== 'string')
        throw new Error(`I18N_KEY_MISSING:${key}`);
    return value.replace(/\{([a-zA-Z0-9_]+)\}/gu, (_match, name) => String(params[name] ?? `{${name}}`));
}
