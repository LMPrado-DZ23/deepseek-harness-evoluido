import { readFileSync } from 'node:fs'

interface CatalogObject { readonly [key: string]: string | CatalogObject }
type CatalogValue = string | CatalogObject

const catalog = JSON.parse(
  readFileSync(new URL('../i18n/pt-BR.json', import.meta.url), 'utf8'),
) as CatalogObject

/**
 * O texto que uma pessoa lê, sempre pelo catálogo.
 *
 * Mesma forma que os outros plugins do Studio usam, e pelo mesmo motivo: uma
 * frase escrita no meio do código escapa do portão de i18n e vira a única
 * mensagem sem tradução na tela inteira.
 * @param key - o caminho da chave no catálogo.
 * @param params - o que preenche os `{marcadores}` da frase.
 * @returns a frase pronta.
 */
export function t(key: string, params: Readonly<Record<string, string | number>> = {}): string {
  const value = key.split('.').reduce<CatalogValue | undefined>((current, part) => {
    return typeof current === 'object' && current !== null ? current[part] : undefined
  }, catalog)
  if (typeof value !== 'string') throw new Error(`I18N_KEY_MISSING:${key}`)
  return value.replace(/\{([a-zA-Z0-9_]+)\}/gu, (_match, name: string) => String(params[name] ?? `{${name}}`))
}
