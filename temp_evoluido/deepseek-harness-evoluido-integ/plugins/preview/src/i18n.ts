import { readFileSync } from 'node:fs'

interface CatalogObject { readonly [key: string]: string | CatalogObject }
type CatalogValue = string | CatalogObject

const catalog = JSON.parse(
  readFileSync(new URL('../i18n/pt-BR.json', import.meta.url), 'utf8'),
) as CatalogObject

export function t(key: string, params: Readonly<Record<string, string | number>> = {}): string {
  const value = key.split('.').reduce<CatalogValue | undefined>((current, part) => {
    return typeof current === 'object' && current !== null ? current[part] : undefined
  }, catalog)
  if (typeof value !== 'string') throw new Error(`I18N_KEY_MISSING:${key}`)
  return value.replace(/\{([a-zA-Z0-9_]+)\}/gu, (_match, name: string) => String(params[name] ?? `{${name}}`))
}
