#!/usr/bin/env node
/**
 * Portão do livro mestre de requisitos.
 *
 * O ledger só vale enquanto ninguém puder afirmar um estado bom sem prova, nem
 * apagar um requisito aceito. Este portão recusa as duas coisas.
 *
 * Uso: node scripts/check-requirements-ledger.mjs [--self-test]
 */
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

/** Vocabulário fechado. Um estado fora daqui é invenção, não estado. */
export const LEDGER_STATES = [
  'STABLE', 'BETA', 'EXPERIMENTAL', 'DISABLED', 'UNSUPPORTED',
  'NOT_PRESENT', 'NOT_CONFIGURED', 'NOT_EXECUTED', 'BLOCKED_EXTERNAL', 'FAILED',
]

/**
 * Estados que afirmam que algo funciona. Eles exigem prova real na linha - e
 * "prova real" não pode ser um travessão nem a palavra `nenhuma`.
 */
const STATES_REQUIRING_PROOF = new Set(['STABLE', 'BETA', 'EXPERIMENTAL'])

/** Palavras que o ledger nunca pode conter: elas transformam intenção em fato. */
const FORBIDDEN_WORDS = [/\bPASS\b/u, /\bpronto\b/iu, /\bfinalizado\b/iu, /\bfunciona\b/iu]

/** Versões-alvo aceitas. Um requisito sem versão-alvo some do roadmap. */
const TARGETS = new Set(['v1.0', 'v1.x', 'v2'])

/**
 * Divide uma linha de tabela markdown em células, respeitando `\|` escapado.
 * @param line - a linha inteira, com as barras das pontas.
 * @returns as células já sem espaço nas pontas.
 */
function cells(line) {
  const parts = []
  let current = ''
  for (let index = 1; index < line.length; index += 1) {
    const character = line[index]
    if (character === '\\' && line[index + 1] === '|') { current += '|'; index += 1; continue }
    if (character === '|') { parts.push(current.trim()); current = ''; continue }
    current += character
  }
  return parts
}

/**
 * Lê as linhas de requisito do ledger.
 * @param source - conteúdo do arquivo.
 * @returns uma entrada por requisito, na ordem do arquivo.
 */
export function parseLedger(source) {
  const rows = []
  for (const line of source.split('\n')) {
    if (!line.startsWith('| ')) continue
    const parts = cells(line)
    if (parts.length < 10) continue
    const [id, requisito, fonte, alvo, estado, arquivos, testes, prova, bloqueio, proximo] = parts
    if (id === 'ID' || /^-+$/u.test(id)) continue
    rows.push({ id, requisito, fonte, alvo, estado, arquivos, testes, prova, bloqueio, proximo })
  }
  return rows
}

/**
 * Uma célula que não diz nada: travessão, vazio, ou a palavra `nenhuma`
 * sozinha.
 *
 * O teste é pela palavra inteira e sozinha de propósito. `nenhuma` é ausência de
 * prova; "Nenhuma rede durante build" é um requisito e "nenhuma CLI externa foi
 * cancelada" é a lacuna escrita. A primeira versão casava por prefixo e apagava
 * as três.
 */
function empty(value) {
  return value === '' || value === '—' || value === '-' || /^nenhuma[.:!]?$/iu.test(value.trim())
}

/**
 * Todos os problemas do ledger, em ordem de leitura.
 * @param rows - as linhas já interpretadas.
 * @param previousIds - ids que existiam antes; nenhum pode sumir.
 * @returns as mensagens de reprovação.
 */
export function ledgerFindings(rows, previousIds = []) {
  const findings = []
  const seen = new Set()
  for (const row of rows) {
    if (seen.has(row.id)) findings.push(`${row.id}: id repetido`)
    seen.add(row.id)
    if (!LEDGER_STATES.includes(row.estado)) {
      findings.push(`${row.id}: estado inventado "${row.estado}"`)
    }
    if (!TARGETS.has(row.alvo)) {
      findings.push(`${row.id}: versão-alvo inválida "${row.alvo}" — um requisito sem alvo some do roadmap`)
    }
    if (empty(row.requisito)) findings.push(`${row.id}: requisito vazio`)
    if (STATES_REQUIRING_PROOF.has(row.estado) && empty(row.prova)) {
      findings.push(`${row.id}: estado ${row.estado} afirma que algo funciona sem prova real`)
    }
    if (row.estado === 'BLOCKED_EXTERNAL' && empty(row.bloqueio)) {
      findings.push(`${row.id}: BLOCKED_EXTERNAL sem dizer o que bloqueia`)
    }
    if (empty(row.proximo)) findings.push(`${row.id}: sem próximo passo`)
    for (const forbidden of FORBIDDEN_WORDS) {
      // A prova pode citar a saída literal de um portão (`I18N_GATE=PASS`); o
      // que não pode é o LEDGER afirmar "pronto" por conta própria.
      const scope = `${row.requisito} ${row.estado}`
      if (forbidden.test(scope)) findings.push(`${row.id}: usa palavra proibida ${String(forbidden)}`)
    }
  }
  for (const id of previousIds) {
    if (!seen.has(id)) findings.push(`${id}: requisito aceito DESAPARECEU do ledger`)
  }
  return findings
}


/**
 * Lê a tabela de RESUMO do fim do ledger: `| \`ESTADO\` | n |`.
 *
 * Ela existe porque ninguém conta 154 linhas a olho. E foi exatamente por isso
 * que ela mentiu por muito tempo: nenhum portão a comparava com as linhas, e os
 * números ficaram parados enquanto o ledger andava. Um resumo errado é pior que
 * resumo nenhum - ele é o número que as pessoas citam.
 * @param source - conteúdo do arquivo.
 * @returns o total declarado por estado e por versão-alvo.
 */
export function parseSummary(source) {
  const states = new Map()
  const targets = new Map()
  for (const line of source.split('\n')) {
    const match = /^\|\s*`?([A-Za-z0-9_.]+)`?\s*\|\s*(\d+)\s*\|\s*$/u.exec(line)
    if (match === null) continue
    const [, name, total] = match
    if (LEDGER_STATES.includes(name)) states.set(name, Number(total))
    else if (TARGETS.has(name)) targets.set(name, Number(total))
  }
  return { states, targets }
}

/**
 * Confere o resumo contra as linhas reais.
 * @param rows - as linhas já interpretadas.
 * @param summary - o resumo declarado no arquivo.
 * @returns as mensagens de reprovação.
 */
export function summaryFindings(rows, summary) {
  const findings = []
  const count = (pick) => {
    const totals = new Map()
    for (const row of rows) totals.set(pick(row), (totals.get(pick(row)) ?? 0) + 1)
    return totals
  }
  for (const [label, declared, real] of [
    ['estado', summary.states, count(row => row.estado)],
    ['versão-alvo', summary.targets, count(row => row.alvo)],
  ]) {
    // Um resumo VAZIO não passa calado: sem esta linha, apagar a tabela inteira
    // faria o portão aprovar por não ter nada com que discordar.
    if (declared.size === 0) {
      findings.push(`resumo: a tabela de ${label} não foi lida — o ledger declara totais que ninguém confere`)
      continue
    }
    for (const [name, total] of real) {
      const said = declared.get(name)
      if (said === undefined) findings.push(`resumo: ${label} "${name}" tem ${String(total)} requisito(s) e não aparece na tabela`)
      else if (said !== total) findings.push(`resumo: ${label} "${name}" diz ${String(said)} e o ledger tem ${String(total)}`)
    }
    for (const [name] of declared) {
      if (!real.has(name)) findings.push(`resumo: ${label} "${name}" aparece na tabela e não existe em nenhuma linha`)
    }
  }
  return findings
}

function selfTest() {
  const good = [{
    id: 'X-1', requisito: 'algo', fonte: 'p', alvo: 'v1.0', estado: 'BETA',
    arquivos: 'a.ts', testes: 't', prova: 'teste: prova real', bloqueio: '—', proximo: 'seguir',
  }]
  const checks = [
    ['linha boa passa', ledgerFindings(good).length === 0],
    ['estado inventado reprova', ledgerFindings([{ ...good[0], estado: 'QUASE' }]).length > 0],
    ['BETA sem prova reprova', ledgerFindings([{ ...good[0], prova: '—' }]).length > 0],
    ['BLOCKED_EXTERNAL sem motivo reprova', ledgerFindings([{ ...good[0], estado: 'BLOCKED_EXTERNAL', bloqueio: '—' }]).length > 0],
    ['alvo inválido reprova', ledgerFindings([{ ...good[0], alvo: 'algum dia' }]).length > 0],
    ['requisito sumido reprova', ledgerFindings(good, ['X-1', 'X-2']).length > 0],
    ['id repetido reprova', ledgerFindings([good[0], good[0]]).length > 0],
    ['sem próximo passo reprova', ledgerFindings([{ ...good[0], proximo: '—' }]).length > 0],
    ['palavra proibida reprova', ledgerFindings([{ ...good[0], requisito: 'está pronto' }]).length > 0],
    ['resumo certo passa', summaryFindings(good, { states: new Map([['BETA', 1]]), targets: new Map([['v1.0', 1]]) }).length === 0],
    ['resumo defasado reprova', summaryFindings(good, { states: new Map([['BETA', 9]]), targets: new Map([['v1.0', 1]]) }).length > 0],
    ['estado ausente do resumo reprova', summaryFindings(good, { states: new Map([['STABLE', 1]]), targets: new Map([['v1.0', 1]]) }).length > 0],
    ['resumo apagado reprova', summaryFindings(good, { states: new Map(), targets: new Map() }).length > 0],
    ['leitura do resumo entende a tabela', parseSummary('| `BETA` | 7 |\n| v1.0 | 3 |').states.get('BETA') === 7],
  ]
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name)
  console.log(`REQUIREMENTS_LEDGER_SELF_TEST=${failed.length === 0 ? 'PASS' : 'FAIL'} checks=${String(checks.length)}${failed.length === 0 ? '' : ` falhou=${failed.join(', ')}`}`)
  return failed.length === 0
}

if (process.argv.includes('--self-test')) {
  process.exitCode = selfTest() ? 0 : 1
} else {
  const source = await readFile('docs/MASTER_REQUIREMENTS_LEDGER.md', 'utf8')
  const rows = parseLedger(source)
  if (rows.length === 0) {
    // Um portão que passa com zero itens é uma falha, não um portão.
    console.error('REQUIREMENTS_LEDGER=FAIL motivo=nenhum requisito foi lido do ledger')
    process.exitCode = 1
  } else {
    const baseline = await readFile('docs/baselines/requirements-ledger-ids.json', 'utf8')
      .then(text => JSON.parse(text), () => [])
    const findings = [...ledgerFindings(rows, baseline), ...summaryFindings(rows, parseSummary(source))]
    for (const finding of findings) console.error(finding)
    const counts = new Map()
    for (const row of rows) counts.set(row.estado, (counts.get(row.estado) ?? 0) + 1)
    const summary = [...counts.entries()].sort().map(([state, total]) => `${state}=${String(total)}`).join(' ')
    console.log(`REQUIREMENTS_LEDGER=${findings.length === 0 ? 'PASS' : 'FAIL'} requisitos=${String(rows.length)} achados=${String(findings.length)} ${summary}`)
    process.exitCode = findings.length === 0 ? 0 : 1
  }
}
