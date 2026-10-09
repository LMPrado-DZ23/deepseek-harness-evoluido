import { readFileSync } from 'node:fs'

const catalog = JSON.parse(
  readFileSync(new URL('../i18n/pt-BR.json', import.meta.url), 'utf8'),
) as Readonly<Record<string, string>>

/**
 * Texto do catálogo, com substituição de `{campo}`. Um campo ausente aparece
 * como `{campo}` em vez de sumir: um buraco visível é melhor do que uma frase
 * que perde a informação sem ninguém notar.
 * @param key - chave do catálogo.
 * @param params - valores a substituir na frase.
 * @returns o texto pronto para a pessoa.
 */
export function t(key: string, params: Readonly<Record<string, string | number>> = {}): string {
  const value = catalog[key]
  if (typeof value !== 'string') throw new Error(`I18N_KEY_MISSING:${key}`)
  return value.replace(/\{([a-zA-Z0-9_]+)\}/gu, (_match, name: string) => String(params[name] ?? `{${name}}`))
}
