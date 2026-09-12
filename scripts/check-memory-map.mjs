import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * O mapa das memórias não pode envelhecer em silêncio.
 *
 * Um mapa desatualizado é pior que nenhum mapa: ele autoriza quem lê a NÃO
 * procurar. Se ele diz que a memória episódica mora em `studio_runs` e esse
 * arquivo foi renomeado, a próxima pessoa conclui que ela não existe — e
 * constrói a segunda.
 *
 * Este portão confere três coisas, e nenhuma delas é estilo:
 *
 * 1. os SETE tipos estão no mapa, com este nome — um tipo que some do mapa é
 *    um tipo que ninguém vai procurar antes de construir de novo;
 * 2. todo arquivo citado EXISTE — citação quebrada é o mapa mentindo;
 * 3. todo estado é um dos três declarados — um estado inventado ("em breve")
 *    transforma uma ausência em promessa.
 */

export const REQUIRED_KINDS = ['decisão', 'episódica', 'semântica', 'avaliação', 'trabalho', 'falha', 'procedimental']
export const ALLOWED_STATES = ['EXISTE', 'PARCIAL', 'AUSENTE']

/**
 * As linhas da tabela do mapa.
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
    if (cells[0] === 'memória' || cells[0].startsWith('---')) continue
    rows.push({ kind: cells[0], what: cells[1], state: cells[2], where: cells[3] })
  }
  return rows
}

/**
 * Os caminhos citados numa célula, que são os de dentro de crase.
 *
 * Só o que está entre crases conta: prosa como "o motor de contexto" não é
 * citação, e tratá-la como tal faria o portão reprovar por causa de uma frase.
 * @param cell - a célula.
 * @returns os caminhos.
 */
export function citationsIn(cell) {
  return [...cell.matchAll(/`([^`]+)`/gu)]
    .map(match => match[1])
    // Uma citação pode nomear um SÍMBOLO dentro do arquivo já citado ao lado
    // (`studioRunsDomainSpec`). Caminho tem barra ou ponto-extensão; o resto é
    // nome de símbolo, e não há arquivo para conferir.
    .filter(value => value.includes('/'))
}

/**
 * Os achados do mapa.
 * @param rows - as linhas já lidas.
 * @param exists - como saber se um caminho existe.
 * @returns os problemas, um por linha.
 */
export function findings(rows, exists) {
  const problems = []
  const seen = new Set(rows.map(row => row.kind))
  for (const kind of REQUIRED_KINDS) {
    if (!seen.has(kind)) problems.push(`o mapa não tem a memória "${kind}": ela some do mapa e ninguém a procura antes de construir de novo`)
  }
  for (const row of rows) {
    if (!ALLOWED_STATES.includes(row.state)) {
      problems.push(`"${row.kind}" tem estado "${row.state}", que não é um dos três permitidos: um estado inventado transforma ausência em promessa`)
    }
    const cited = citationsIn(row.where)
    if (row.state !== 'AUSENTE' && cited.length === 0) {
      problems.push(`"${row.kind}" diz ${row.state} e não cita arquivo nenhum: um estado sem citação não é conferível`)
    }
    if (row.state === 'AUSENTE' && cited.length > 0) {
      problems.push(`"${row.kind}" diz AUSENTE e cita ${cited.join(', ')}: se há onde morar, ela não está ausente`)
    }
    for (const path of cited) {
      if (!exists(path)) problems.push(`"${row.kind}" cita ${path}, que não existe: citação quebrada é o mapa mentindo`)
    }
  }
  return problems
}

const MAP_PATH = 'docs/architecture/MEMORY_MAP.md'

if (process.argv.includes('--self-test')) {
  const checks = []
  const fail = message => { process.stderr.write(`MEMORY_MAP_SELF_TEST=FAIL ${message}\n`); process.exit(1) }
  const sempre = () => true
  const nunca = () => false

  const completo = REQUIRED_KINDS.map(kind => ({ kind, what: 'x', state: 'EXISTE', where: '`src/a.ts`' }))

  if (findings(completo, sempre).length !== 0) fail('reprovou um mapa completo e correto')
  checks.push('mapa-correto-passa')

  if (findings(completo.slice(1), sempre).length !== 1) fail('nao pegou um tipo faltando')
  checks.push('tipo-faltando')

  if (findings(completo, nunca).length !== REQUIRED_KINDS.length) fail('nao pegou citacao quebrada')
  checks.push('citacao-quebrada')

  const inventado = [...completo.slice(1), { kind: 'decisão', what: 'x', state: 'EM BREVE', where: '`src/a.ts`' }]
  if (!findings(inventado, sempre).some(item => item.includes('não é um dos três'))) fail('aceitou estado inventado')
  checks.push('estado-inventado')

  const semCitar = [...completo.slice(1), { kind: 'decisão', what: 'x', state: 'EXISTE', where: 'o motor de decisão' }]
  if (!findings(semCitar, sempre).some(item => item.includes('não é conferível'))) fail('aceitou EXISTE sem citacao')
  checks.push('existe-sem-citacao')

  const ausenteQueCita = [...completo.slice(1), { kind: 'decisão', what: 'x', state: 'AUSENTE', where: '`src/a.ts`' }]
  if (!findings(ausenteQueCita, sempre).some(item => item.includes('ela não está ausente'))) fail('aceitou AUSENTE com citacao')
  checks.push('ausente-que-cita')

  // AUSENTE sem citação é o caso legítimo, e ele tem de PASSAR.
  const ausente = [...completo.slice(1), { kind: 'decisão', what: 'x', state: 'AUSENTE', where: '—' }]
  if (findings(ausente, sempre).length !== 0) fail('reprovou AUSENTE legitimo')
  checks.push('ausente-legitimo')

  // Prosa entre crases que NÃO é caminho não vira citação a conferir.
  if (citationsIn('`studioRunsDomainSpec`').length !== 0) fail('tratou nome de simbolo como caminho')
  if (citationsIn('`src/a.ts`, `src/b.ts`').length !== 2) fail('nao leu duas citacoes')
  checks.push('simbolo-nao-e-caminho')

  // A tabela é lida de um markdown de verdade, e não de uma lista já pronta.
  const lido = parseMap('| memória | o que | estado | onde |\n| --- | --- | --- | --- |\n| falha | x | PARCIAL | `src/a.ts` |\n\ntexto solto\n')
  if (lido.length !== 1 || lido[0].state !== 'PARCIAL') fail(`leu ${String(lido.length)} linhas em vez de 1`)
  checks.push('leitura-da-tabela')

  // O documento REAL passa. Sem isto, o autoteste provaria a função e não o mapa.
  const real = parseMap(readFileSync(resolve(process.cwd(), MAP_PATH), 'utf8'))
  if (real.length < REQUIRED_KINDS.length) fail(`o documento real tem ${String(real.length)} linhas`)
  checks.push('documento-real')

  process.stdout.write(`MEMORY_MAP_SELF_TEST=PASS checks=${String(checks.length)}\n`)
  process.exit(0)
}

const root = process.cwd()
const rows = parseMap(readFileSync(resolve(root, MAP_PATH), 'utf8'))
const problems = findings(rows, path => existsSync(resolve(root, path)))
if (problems.length > 0) {
  process.stderr.write(`MEMORY_MAP=FAIL\n- ${problems.join('\n- ')}\n`)
  process.exit(1)
}
const porEstado = ALLOWED_STATES.map(state => `${state}=${String(rows.filter(row => row.state === state).length)}`).join(' ')
process.stdout.write(`MEMORY_MAP=PASS memorias=${String(rows.length)} ${porEstado}\n`)
