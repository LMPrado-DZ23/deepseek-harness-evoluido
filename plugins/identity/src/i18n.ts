import { readFileSync } from 'node:fs'

const catalog = JSON.parse(
  readFileSync(new URL('../i18n/pt-BR.json', import.meta.url), 'utf8'),
) as Readonly<Record<string, string>>

export function t(key: string): string {
  const value = catalog[key]
  if (typeof value !== 'string') throw new Error(`I18N_KEY_MISSING:${key}`)
  return value
}
