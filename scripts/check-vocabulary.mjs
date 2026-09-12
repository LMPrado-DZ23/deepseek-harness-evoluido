import { readFileSync, readdirSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

/**
 * UMA palavra para UMA coisa, nos textos que a pessoa lê.
 *
 * Este portão nasceu de um defeito observado, e não de gosto: o domínio chamava
 * "missão" o que a tela chamava "objetivo", e a recusa de repetido chegou à
 * pessoa dizendo "Já existe uma missão com este identificador" — nomeando DUAS
 * coisas que ela nunca viu: a palavra do domínio e uma chave escondida de
 * propósito pelo formulário.
 *
 * O nome interno pode ser o que for. `plugins/mission`, `MissionRecord`,
 * `studio_missions` continuam como estão: quem lê código é quem escreve código.
 * O que este portão olha é só o CATÁLOGO — as frases que saem na tela.
 *
 * Duas severidades, de propósito:
 *
 * - PROIBIDO: reprova. É a palavra que já foi corrigida e não pode voltar.
 * - TETO: conta e compara com um número cravado. É a palavra que ainda está
 *   espalhada demais para uma troca que eu consiga conferir de uma vez. O teto
 *   não pode crescer, então o erro para de se espalhar enquanto a limpeza não
 *   acontece — e o número fica impresso, em vez de virar uma intenção.
 */

/** Os termos que NÃO podem aparecer em texto que a pessoa lê. */
export const FORBIDDEN = [
  {
    term: 'missão',
    pattern: /\bmiss(ão|ões)\b/giu,
    instead: 'objetivo',
    reason: 'a tela chama "objetivo"; duas palavras para a mesma coisa fazem a recusa do servidor falar de algo que a pessoa nunca viu',
  },
]

/**
 * Os termos que ainda estão espalhados, com o número que não pode crescer.
 *
 * Cada um nomeia com o que deveria ser trocado. O teto é o que EXISTE hoje,
 * medido — não um alvo, e não uma estimativa.
 */
export const CEILINGS = [
  { term: 'identificador', pattern: /\bidentificador(es)?\b/giu, instead: 'o nome que a pessoa deu, ou nada', ceiling: 13 },
  { term: 'execução', pattern: /\bexecu(ção|ções)\b/giu, instead: 'trabalho', ceiling: 37 },
]

/**
 * As chaves de um catálogo, achatadas em pares caminho/frase.
 * @param value - o catálogo, ou um pedaço dele.
 * @param prefix - o caminho até aqui.
 * @returns os pares.
 */
export function flatten(value, prefix = '') {
  if (typeof value === 'string') return [[prefix, value]]
  if (Array.isArray(value)) return value.flatMap((child, index) => flatten(child, `${prefix}[${String(index)}]`))
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => flatten(child, prefix === '' ? key : `${prefix}.${key}`))
  }
  return []
}

/**
 * Os achados de um conjunto de catálogos.
 *
 * Devolve os proibidos encontrados e a contagem de cada termo com teto. Função
 * PURA, para que o autoteste possa alimentá-la com catálogos de mentira sem
 * tocar em disco.
 * @param catalogs - pares de nome e conteúdo já lido.
 * @returns os achados e as contagens.
 */
export function inspect(catalogs) {
  const findings = []
  const counts = Object.fromEntries(CEILINGS.map(entry => [entry.term, 0]))
  for (const { name, catalog } of catalogs) {
    for (const [key, phrase] of flatten(catalog)) {
      for (const rule of FORBIDDEN) {
        rule.pattern.lastIndex = 0
        if (rule.pattern.test(phrase)) {
          findings.push(`${name} ${key}: diz "${rule.term}" onde a pessoa espera "${rule.instead}" — ${rule.reason}`)
        }
      }
      for (const rule of CEILINGS) {
        counts[rule.term] += (phrase.match(rule.pattern) ?? []).length
      }
    }
  }
  return { findings, counts }
}

/**
 * Os catálogos que a pessoa lê.
 * @param root - a raiz do repositório.
 * @returns os caminhos.
 */
export function userFacingCatalogs(root) {
  const found = []
  const appDir = resolve(root, 'apps/studio-web/src/i18n')
  for (const file of readdirSync(appDir)) if (file.endsWith('.json')) found.push(resolve(appDir, file))
  const pluginsDir = resolve(root, 'plugins')
  for (const plugin of readdirSync(pluginsDir)) {
    const dir = resolve(pluginsDir, plugin, 'i18n')
    try { if (!statSync(dir).isDirectory()) continue } catch { continue }
    for (const file of readdirSync(dir)) if (file.endsWith('.json')) found.push(resolve(dir, file))
  }
  return found.sort()
}

if (process.argv.includes('--self-test')) {
  const checks = []
  const fail = message => { process.stderr.write(`VOCABULARY_SELF_TEST=FAIL ${message}\n`); process.exit(1) }

  // 1. O proibido é pego.
  const pego = inspect([{ name: 'x', catalog: { a: 'A missão foi encontrada.' } }])
  if (pego.findings.length !== 1) fail('nao pegou o termo proibido')
  checks.push('proibido')

  // 2. E é pego no PLURAL também.
  if (inspect([{ name: 'x', catalog: { a: 'Suas missões.' } }]).findings.length !== 1) fail('nao pegou o plural')
  checks.push('plural')

  // 3. `permissão` NÃO é `missão`. Sem a fronteira de palavra, este portão
  //    reprovaria metade dos catálogos do produto no primeiro dia — e um portão
  //    que reprova tudo é desligado na primeira semana.
  if (inspect([{ name: 'x', catalog: { a: 'Você não tem permissão para isso.' } }]).findings.length !== 0) {
    fail('confundiu permissao com missao')
  }
  checks.push('fronteira-de-palavra')

  // 4. Nem `comissão`, `emissão`, `submissão`.
  for (const palavra of ['comissão', 'emissão', 'submissão', 'admissões']) {
    if (inspect([{ name: 'x', catalog: { a: `Uma ${palavra} qualquer.` } }]).findings.length !== 0) {
      fail(`confundiu ${palavra} com missao`)
    }
  }
  checks.push('sufixos')

  // 5. Frase limpa passa.
  if (inspect([{ name: 'x', catalog: { a: 'Este objetivo não foi encontrado.' } }]).findings.length !== 0) {
    fail('reprovou frase limpa')
  }
  checks.push('frase-limpa')

  // 6. O aninhamento é percorrido: um termo escondido três níveis abaixo conta.
  if (inspect([{ name: 'x', catalog: { a: { b: { c: 'A missão sumiu.' } } } }]).findings.length !== 1) {
    fail('nao desceu no aninhamento')
  }
  checks.push('aninhamento')

  // 7. Lista dentro do catálogo também é percorrida.
  if (inspect([{ name: 'x', catalog: { a: ['tudo bem', 'a missão sumiu'] } }]).findings.length !== 1) {
    fail('nao percorreu lista')
  }
  checks.push('lista')

  // 8. A contagem do teto soma OCORRÊNCIAS, e não frases: duas na mesma frase
  //    são duas. Contar frases deixaria o termo se espalhar dentro delas.
  const contagem = inspect([{ name: 'x', catalog: { a: 'A execução e a execução de novo.' } }])
  if (contagem.counts['execução'] !== 2) fail(`contou ${String(contagem.counts['execução'])} em vez de 2`)
  checks.push('teto-conta-ocorrencias')

  // 9. A contagem é case-insensitive nos dois lados.
  if (inspect([{ name: 'x', catalog: { a: 'IDENTIFICADOR' } }]).counts['identificador'] !== 1) fail('contagem nao ignorou caixa')
  checks.push('teto-ignora-caixa')

  // 10. `lastIndex` não vaza entre frases: um regex global com `test` guarda
  //     posição, e sem o reset a SEGUNDA frase idêntica passava batida. Este é
  //     o defeito que o portão teria contra si mesmo.
  const duas = inspect([{ name: 'x', catalog: { a: 'A missão sumiu.', b: 'A missão sumiu.' } }])
  if (duas.findings.length !== 2) fail(`lastIndex vazou: ${String(duas.findings.length)} achados em vez de 2`)
  checks.push('sem-vazamento-de-lastIndex')

  // 11. Os catálogos de verdade são encontrados, e são muitos.
  if (userFacingCatalogs(process.cwd()).length < 5) fail('nao achou os catalogos do produto')
  checks.push('catalogos-encontrados')

  process.stdout.write(`VOCABULARY_SELF_TEST=PASS checks=${String(checks.length)}\n`)
  process.exit(0)
}

const root = process.cwd()
const catalogs = userFacingCatalogs(root).map(path => ({
  name: relative(root, path).split(sep).join('/'),
  catalog: JSON.parse(readFileSync(path, 'utf8')),
}))
const { findings, counts } = inspect(catalogs)
const failures = [...findings]
for (const rule of CEILINGS) {
  if (counts[rule.term] > rule.ceiling) {
    failures.push(`"${rule.term}" cresceu (${String(counts[rule.term])} > ${String(rule.ceiling)}): troque por "${rule.instead}" em vez de aumentar o teto`)
  }
}
if (failures.length > 0) {
  process.stderr.write(`VOCABULARY=FAIL\n- ${failures.join('\n- ')}\n`)
  process.exit(1)
}
const tetos = CEILINGS.map(rule => `${rule.term}=${String(counts[rule.term])}/${String(rule.ceiling)}`).join(' ')
process.stdout.write(`VOCABULARY=PASS catalogos=${String(catalogs.length)} proibidos=${String(findings.length)} ${tetos}\n`)
