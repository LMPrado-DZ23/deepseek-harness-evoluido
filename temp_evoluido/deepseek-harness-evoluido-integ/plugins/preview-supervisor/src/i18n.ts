import { readFileSync } from 'node:fs'

const catalog = JSON.parse(
  readFileSync(new URL('../i18n/pt-BR.json', import.meta.url), 'utf8'),
) as Readonly<Record<string, Readonly<Record<string, string>>>>

export function t(key: string): string {
  const [section, name] = key.split('.', 2)
  const value = section === undefined || name === undefined ? undefined : catalog[section]?.[name]
  if (value === undefined) throw new Error(`I18N_KEY_MISSING:${key}`)
  return value
}
