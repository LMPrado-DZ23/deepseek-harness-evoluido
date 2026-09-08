/**
 * O ambiente do processo filho, construído do zero.
 *
 * Este arquivo existe para que só haja UM lugar capaz de decidir o que o
 * servidor MCP enxerga como ambiente — e para que esse lugar nunca leia
 * `process.env`. Herdar o ambiente do Studio é como um segredo vaza: o processo
 * do Studio carrega referências de cofre, tokens de provedor, DSN de banco e a
 * topologia da máquina, e um servidor MCP de terceiro que receba tudo isso não
 * precisa de nenhuma falha para exfiltrá-lo — basta ele ler `process.env`.
 */
import { t } from './i18n.js'
import { ENVIRONMENT_NAME } from './model.js'

export class McpEnvironmentError extends Error {
  constructor(readonly code: 'NAME_INVALID' | 'VALUE_INVALID', message: string) {
    super(message)
    this.name = 'McpEnvironmentError'
  }
}

/**
 * O ambiente COMPLETO do processo filho: exatamente o que foi declarado.
 *
 * Não há acréscimo, não há herança e não há padrão implícito — nem `PATH`. Um
 * servidor que precisa de `PATH` tem de tê-lo declarado no cadastro, e aí quem
 * administra o Studio viu o que estava dando. O objeto volta sem protótipo: um
 * cadastro com a chave `__proto__` não planta nada no `Object` deste processo.
 * @param declared - as variáveis que este servidor pode enxergar.
 * @returns o ambiente literal a entregar ao `spawn`.
 */
export function childEnvironment(declared: Readonly<Record<string, string>>): Record<string, string> {
  const environment: Record<string, string> = Object.create(null) as Record<string, string>
  for (const name of Object.keys(declared)) {
    if (!ENVIRONMENT_NAME.test(name)) throw new McpEnvironmentError('NAME_INVALID', t('errors.environmentNameInvalid', { name }))
    const value = declared[name]
    // Só texto, e sem byte zero. O tipo é conferido porque o cadastro pode vir
    // de JSON: `JSON.parse('{"__proto__": {...}}')` produz uma chave PRÓPRIA
    // cujo valor é um objeto, e ela passa pelo teste de nome acima. Um byte
    // zero, por sua vez, corta a string no limite do processo — o que o Studio
    // acha que declarou e o que o filho recebe deixariam de ser a mesma coisa.
    if (typeof value !== 'string' || value.includes('\u0000')) {
      throw new McpEnvironmentError('VALUE_INVALID', t('errors.environmentValueInvalid', { name }))
    }
    environment[name] = value
  }
  return environment
}
