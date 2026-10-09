import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * A constituição não se obriga sozinha.
 *
 * Este portão faz duas coisas que parecem distantes e são a mesma:
 *
 * 1. confere o MAPA — toda cláusula listada aponta para um portão que existe
 *    no `package.json` ou para um arquivo que existe no disco, e nenhum estado
 *    foi inventado. Um mapa que envelhece em silêncio autoriza quem lê a supor
 *    que a constituição se obriga sozinha;
 * 2. confere a cláusula **5.1** — *"um portão que passa com zero itens é uma
 *    falha, não um portão"*. Ela é a única cláusula de "critério de verdade"
 *    que uma máquina consegue conferir, e até aqui ninguém a conferia: um
 *    portão que deixou de achar o que procurar passa, e passar é exatamente o
 *    que ele faria se tudo estivesse certo.
 */

export const ALLOWED_STATES = ['PORTÃO', 'CÓDIGO', 'NÃO AUTOMATIZADO']
const MAP_PATH = 'docs/architecture/CONSTITUTION_MAP.md'

/**
 * As linhas do mapa.
 * @param markdown - o documento.
 * @returns uma entrada por linha de tabela.
 */
export function parseMap(markdown) {
  const rows = []
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue
    const cells = trimmed.slice(1, -1).split('|').map(cell => cell.trim())
    if (cells.length !== 4) continue
    if (cells[0] === 'cláusula' || cells[0].startsWith('---')) continue
    rows.push({ clause: cells[0], what: cells[1], state: cells[2], who: cells[3] })
  }
  return rows
}

/**
 * Os achados do mapa.
 * @param rows - as linhas.
 * @param hasGate - se um portão existe.
 * @param hasFile - se um arquivo existe.
 * @returns os problemas.
 */
export function mapFindings(rows, hasGate, hasFile) {
  const problems = []
  if (rows.length === 0) problems.push('o mapa não tem cláusula nenhuma: um portão que não olha nada não é portão')
  const seen = new Set()
  for (const row of rows) {
    if (seen.has(row.clause)) problems.push(`a cláusula ${row.clause} aparece duas vezes: duas linhas para a mesma regra divergem no primeiro conserto`)
    seen.add(row.clause)
    if (!ALLOWED_STATES.includes(row.state)) {
      problems.push(`a cláusula ${row.clause} tem estado "${row.state}", que não é um dos três permitidos`)
    }
    // `[a-z0-9-]` e nao `[a-z-]`: `gate:i18n` tem digito no nome, e a primeira
    // versao desta expressao nao o reconhecia — o portao acusava a clausula 5.3
    // de nao nomear portao nenhum quando ela nomeava.
    const gates = [...row.who.matchAll(/`(gate:[a-z0-9-]+)`/gu)].map(match => match[1])
    const files = [...row.who.matchAll(/`([^`]*\/[^`]*)`/gu)].map(match => match[1])
    if (row.state === 'PORTÃO' && gates.length === 0) {
      problems.push(`a cláusula ${row.clause} diz PORTÃO e não nomeia portão nenhum: um estado sem quem o sustente não é conferível`)
    }
    if (row.state === 'CÓDIGO' && files.length === 0) {
      problems.push(`a cláusula ${row.clause} diz CÓDIGO e não cita arquivo nenhum`)
    }
    if (row.state === 'NÃO AUTOMATIZADO' && (gates.length > 0 || files.length > 0)) {
      problems.push(`a cláusula ${row.clause} diz NÃO AUTOMATIZADO e cita quem obriga: se há quem obrigue, ela é automatizada`)
    }
    for (const gate of gates) if (!hasGate(gate)) problems.push(`a cláusula ${row.clause} cita ${gate}, que não existe no package.json`)
    for (const file of files) if (!hasFile(file)) problems.push(`a cláusula ${row.clause} cita ${file}, que não existe`)
  }
  return problems
}

/**
 * Os contadores de uma linha de veredito.
 *
 * Um veredito é `NOME=PASS chave=valor chave=valor`. O que interessa são os
 * valores NUMÉRICOS: eles dizem quantos itens o portão de fato olhou.
 * @param line - a linha.
 * @returns os pares com valor numérico.
 */
export function countersOf(line) {
  return [...line.matchAll(/([a-z_]+)=(\d+)(?:\/(\d+))?/giu)]
    .map(match => ({ name: match[1], value: Number(match[2]) }))
}

/**
 * Os portões que passaram sem olhar nada.
 *
 * Um contador de ACHADOS em zero é bom — é o portão dizendo que não há
 * problema. O que não pode ser zero é a quantidade de coisas OLHADAS, e a
 * diferença entre os dois é o nome: contadores de achado são nomeados, e o
 * resto é sujeito.
 * @param verdicts - as linhas de veredito, uma por portão.
 * @returns os portões vazios, com a linha.
 */
export function emptyGates(verdicts) {
  // Estes nomeiam ACHADOS, e zero neles é o desfecho bom. Todo o resto é
  // SUJEITO, e zero nele quer dizer que o portão não olhou nada.
  const findings = new Set([
    'achados', 'problemas', 'proibidos', 'violacoes', 'falhas', 'pendentes',
    'grandfathered', 'plugin_literals_grandfathered', 'generated_source_literals',
    'saidas_explicitas', 'numeros_compartilhados', 'FAILED', 'NOT_CONFIGURED',
    'NOT_EXECUTED', 'NOT_PRESENT', 'Proposta', 'Rejeitada', 'AUSENTE', 'PARCIAL',
    'Substituída',
  ])
  const empty = []
  for (const line of verdicts) {
    const trimmed = line.trim()
    if (trimmed === '' || !trimmed.includes('=')) continue
    const subjects = countersOf(trimmed).filter(counter => !findings.has(counter.name))
    if (subjects.length === 0) continue
    if (subjects.every(counter => counter.value === 0)) empty.push(trimmed)
  }
  return empty
}

/**
 * Os problemas que a cláusula 5.1 encontra num conjunto de vereditos.
 *
 * É uma função, e não um trecho dentro do corpo do script, pela razão que esta
 * missão já aprendeu três vezes: código que só roda no caminho principal não é
 * exercido por teste nenhum. A primeira versão disto era um laço solto, e a
 * sabotagem que o esvaziava passava — com a função de detecção intacta e a
 * fiação morta.
 * @param lines - as linhas de veredito.
 * @returns os problemas, já com a frase que nomeia a cláusula.
 */
export function verdictProblems(lines) {
  return emptyGates(lines).map(line =>
    `portão passou olhando ZERO itens, o que a cláusula 5.1 chama de falha: ${line}`)
}

if (process.argv.includes('--self-test')) {
  const checks = []
  const fail = message => { process.stderr.write(`CONSTITUTION_SELF_TEST=FAIL ${message}\n`); process.exit(1) }
  const sim = () => true
  const nao = () => false

  const linha = (over = {}) => ({ clause: '3', what: 'x', state: 'PORTÃO', who: '`gate:upstream-pin`', ...over })

  if (mapFindings([linha()], sim, sim).length !== 0) fail('reprovou um mapa correto')
  checks.push('mapa-correto')

  if (mapFindings([], sim, sim).length !== 1) fail('aceitou mapa vazio')
  checks.push('mapa-vazio')

  if (mapFindings([linha(), linha()], sim, sim).some(item => item.includes('duas vezes')) !== true) fail('aceitou clausula repetida')
  checks.push('clausula-repetida')

  if (!mapFindings([linha({ state: 'EM BREVE' })], sim, sim).some(item => item.includes('não é um dos três'))) fail('aceitou estado inventado')
  checks.push('estado-inventado')

  if (!mapFindings([linha({ who: 'alguém confere' })], sim, sim).some(item => item.includes('não nomeia portão'))) fail('aceitou PORTÃO sem portão')
  checks.push('portao-sem-portao')

  // Nome de portão com DÍGITO. A primeira versão da expressão usava `[a-z-]` e
  // não reconhecia `gate:i18n` — e acusava a cláusula que o cita de não citar
  // portão nenhum. Foi o documento real que pegou, e não o autoteste.
  if (mapFindings([linha({ who: '`gate:i18n`' })], sim, sim).length !== 0) fail('nao reconheceu portao com digito no nome')
  checks.push('portao-com-digito')

  if (!mapFindings([linha({ state: 'NÃO AUTOMATIZADO' })], sim, sim).some(item => item.includes('ela é automatizada'))) fail('aceitou NÃO AUTOMATIZADO que cita portão')
  checks.push('nao-automatizado-que-cita')

  if (mapFindings([linha({ state: 'NÃO AUTOMATIZADO', who: 'ninguém confere hoje' })], sim, sim).length !== 0) fail('reprovou NÃO AUTOMATIZADO legítimo')
  checks.push('nao-automatizado-legitimo')

  if (!mapFindings([linha()], nao, sim).some(item => item.includes('não existe no package.json'))) fail('aceitou portão inexistente')
  checks.push('portao-inexistente')

  if (!mapFindings([linha({ state: 'CÓDIGO', who: '`src/a.ts`' })], sim, nao).some(item => item.includes('que não existe'))) fail('aceitou arquivo inexistente')
  checks.push('arquivo-inexistente')

  // ── a cláusula 5.1 ──────────────────────────────────────────────────────
  if (emptyGates(['X=PASS arquivos=0']).length !== 1) fail('não pegou portão que olhou zero')
  checks.push('portao-vazio')

  if (emptyGates(['X=PASS arquivos=5734 achados=0']).length !== 0) fail('reprovou portão com achados zero, que é o desfecho bom')
  checks.push('achados-zero-e-bom')

  if (emptyGates(['X=PASS migrados=8/27 pendentes=19']).length !== 0) fail('reprovou veredito com fração')
  checks.push('fracao')

  if (emptyGates(['X=PASS', '', 'texto solto']).length !== 0) fail('inventou achado em linha sem contador')
  checks.push('linha-sem-contador')

  if (emptyGates(['X=PASS catalogos=0 chaves=0']).length !== 1) fail('não pegou dois sujeitos em zero')
  checks.push('todos-os-sujeitos-zero')

  if (emptyGates(['X=PASS catalogos=0 chaves=12']).length !== 0) fail('reprovou portão com um sujeito zero e outro não')
  checks.push('um-sujeito-zero-outro-nao')

  // A FIAÇÃO da cláusula 5.1, e não só a detecção dela: sem isto, esvaziar o
  // laço que transforma achado em problema passava despercebido.
  if (verdictProblems(['X=PASS arquivos=0']).length !== 1) fail('a clausula 5.1 nao vira problema')
  if (!verdictProblems(['X=PASS arquivos=0'])[0].includes('5.1')) fail('o problema nao nomeia a clausula')
  if (verdictProblems(['X=PASS arquivos=9 achados=0']).length !== 0) fail('a clausula 5.1 acusou portao saudavel')
  checks.push('fiacao-da-clausula-5-1')

  // O documento REAL passa. Sem isto o autoteste provaria a função, não o mapa.
  const real = parseMap(readFileSync(resolve(process.cwd(), MAP_PATH), 'utf8'))
  if (real.length < 10) fail(`o documento real tem ${String(real.length)} cláusulas`)
  checks.push('documento-real')

  process.stdout.write(`CONSTITUTION_SELF_TEST=PASS checks=${String(checks.length)}\n`)
  process.exit(0)
}

const root = process.cwd()
const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts ?? {}
const rows = parseMap(readFileSync(resolve(root, MAP_PATH), 'utf8'))
const problems = mapFindings(
  rows,
  gate => Object.prototype.hasOwnProperty.call(scripts, gate),
  file => existsSync(resolve(root, file)),
)

// `--verdicts <arquivo>`: confere a cláusula 5.1 sobre os vereditos gravados.
const index = process.argv.indexOf('--verdicts')
let checked = 0
if (index >= 0) {
  const path = process.argv[index + 1]
  if (path === undefined) {
    problems.push('`--verdicts` exige o caminho do arquivo com as linhas de veredito')
  } else {
    const lines = readFileSync(resolve(root, path), 'utf8').split('\n')
    checked = lines.filter(line => line.includes('=')).length
    problems.push(...verdictProblems(lines))
  }
}

if (problems.length > 0) {
  process.stderr.write(`CONSTITUTION=FAIL\n- ${problems.join('\n- ')}\n`)
  process.exit(1)
}
const porEstado = ALLOWED_STATES.map(state => `${state.replace(/\s/gu, '_')}=${String(rows.filter(row => row.state === state).length)}`).join(' ')
process.stdout.write(`CONSTITUTION=PASS clausulas=${String(rows.length)} ${porEstado} vereditos_conferidos=${String(checked)}\n`)
