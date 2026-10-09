#!/usr/bin/env node
/**
 * Portão do registro de decisões.
 *
 * Recusa três coisas que já estavam nesta árvore e que fazem uma ADR deixar de
 * ser registro e virar prosa arquivada:
 *
 * 1. cabeçalho que nenhuma máquina lê — o estado aparecia em seis sintaxes
 *    diferentes, e um estado que só uma pessoa consegue interpretar não é
 *    consultável por nada que vá decidir alguma coisa;
 * 2. elo de substituição de uma perna só — a ADR-019 dizia "substituído pelo
 *    ADR-022" e a ADR-022 não dizia nada de volta: quem chegasse pela ADR-022
 *    não tinha como saber que estava lendo a decisão vigente;
 * 3. CITAÇÃO AMBÍGUA — `ADR-038` nomeia três decisões diferentes e `ADR-034`
 *    nomeia duas, e `ADR-039` nomeia duas. Havia SETE citações vivas apontando
 *    para um número compartilhado — uma delas no perfil que MONTA o plugin.
 *    Seguir qualquer uma leva a uma pasta com três respostas.
 *
 * O terceiro é o que este portão existe para impedir de voltar, e é o único que
 * varre a árvore inteira: o defeito não mora na ADR, mora em quem a cita.
 *
 * Este arquivo escreve numeros ambiguos DE PROPOSITO, para explicar e para
 * exercitar a regra: citacao-ambigua-proposital
 *
 * Uso: node scripts/check-decision-record.mjs [--self-test]
 */
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { collectionFindings, parseDecision, readDecisions, resolveCitation, sharedNumbers, STATES } from './decision-record.mjs'

/**
 * Onde uma citação ambígua importa.
 *
 * Tudo o que é rastreado pelo git, menos o upstream pinado (que tem ADRs
 * próprias e não fala das nossas), menos a própria pasta `docs/adr` — lá o
 * número aparece no título de cada arquivo por desenho — e menos os relatórios
 * de auditoria, que CITAM o achado e precisam poder escrever o número ambíguo
 * para descrevê-lo.
 */
const IGNORED_PREFIXES = ['third_party/', 'audit/', 'vendor/', 'node_modules/']

/**
 * A saída para quem escreve o número ambíguo DE PROPÓSITO.
 *
 * Alguns arquivos precisam escrever `ADR-038` para falar DA ambiguidade, e não
 * para citar uma decisão: os auto-testes deste portão provam que esse número
 * não resolve — e não há como provar isso sem escrevê-lo —, a ADR-047 explica o
 * defeito nomeando os três números, e o livro mestre registra o achado.
 *
 * A saída é explícita e vale para o arquivo inteiro, mas o portão CONTA quantos
 * arquivos a usam e imprime o número no veredito: uma saída silenciosa viraria
 * o buraco por onde toda citação quebrada futura passaria despercebida.
 *
 * A primeira versão deste portão trazia uma lista fixa com os dois arquivos do
 * próprio portão. Ela reprovou no mesmo dia, contra a ADR e o livro mestre que
 * este trabalho escreveu — que é exatamente o caso que a lista fixa não previa.
 */
const ESCAPE = 'citacao-ambigua-proposital'

/** Um `ADR-NNN` que não é seguido pelo resto do nome do arquivo. */
const BARE_CITATION = /ADR-(\d{3})(?![\w-])/gu

/**
 * Os arquivos rastreados que podem conter citação.
 * @returns os caminhos.
 */
function trackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return output.split('\0')
    .filter(path => path !== '')
    .filter(path => !IGNORED_PREFIXES.some(prefix => path.startsWith(prefix)))

    .filter(path => /\.(md|ts|tsx|mjs|js|json|yaml|yml)$/u.test(path))
}

/**
 * As citações ambíguas de um texto.
 * @param path - o arquivo, para a mensagem.
 * @param source - o conteúdo.
 * @param ambiguous - os números que nomeiam mais de uma decisão.
 * @returns as mensagens de reprovação.
 */
export function citationFindings(path, source, ambiguous) {
  if (ambiguous.length === 0) return []
  if (source.includes(ESCAPE)) return []
  const findings = []
  const lines = source.split('\n')
  for (const [index, line] of lines.entries()) {
    // O titulo de uma ADR escreve o proprio numero por desenho; nao e citacao.
    if (line.startsWith('# ADR-')) continue
    for (const match of line.matchAll(BARE_CITATION)) {
      if (!ambiguous.includes(match[1])) continue
      findings.push(`${path}:${String(index + 1)}: cita "ADR-${match[1]}", que nomeia mais de uma decisao — escreva o nome completo do arquivo`)
    }
  }
  return findings
}

/** Os auto-testes: cada regra provada contra um caso que DEVE reprovar. */
export function selfTest() {
  const checks = []
  const ok = (label, condition) => { checks.push(label); if (!condition) throw new Error(`auto-teste falhou: ${label}`) }
  const doc = (slug, body) => parseDecision(slug, body)
  const good = '# ADR-099 — Uma decisao\n\n- Estado: Aceita\n- Data: 2026-09-12\n\n## Contexto\n\nprosa: com dois pontos\n'

  ok('cabecalho canonico passa', doc('ADR-099-uma-decisao', good).findings.length === 0)
  ok('sem estado reprova', doc('ADR-099-uma-decisao', good.replace('- Estado: Aceita\n', '')).findings.length === 1)
  ok('estado livre reprova', doc('ADR-099-uma-decisao', good.replace('Aceita', 'aceito para BETA em M75')).findings.length === 1)
  ok('sem data reprova', doc('ADR-099-uma-decisao', good.replace('- Data: 2026-09-12\n', '')).findings.length === 1)
  ok('data em prosa reprova', doc('ADR-099-uma-decisao', good.replace('2026-09-12', '12/09/2026')).findings.length === 1)
  ok('numero do titulo divergente reprova', doc('ADR-098-uma-decisao', good).findings.length === 1)
  ok('nome de arquivo fora do padrao reprova', doc('adr-99', good).findings.length === 1)
  ok('campo repetido reprova', doc('ADR-099-uma-decisao', good.replace('- Data: 2026-09-12', '- Data: 2026-09-12\n- Data: 2026-09-13')).findings.length === 1)
  // O corpo da ADR tem listas com dois-pontos; o parser nao pode le-las.
  ok('parser para no primeiro subtitulo', doc('ADR-099-uma-decisao', `${good}\n- Estado: Rejeitada\n`).findings.length === 0)
  ok('substituida sem destino reprova', doc('ADR-099-uma-decisao', good.replace('Aceita', 'Substituída')).findings.length === 1)
  ok('destino sem estado substituida reprova', doc('ADR-099-uma-decisao', `${good}`.replace('- Data:', '- Substituida por: ADR-100-outra\n- Data:')).findings.length === 1)
  ok('lista fechada de estados', STATES.length === 4)

  const velha = doc('ADR-019-velha', '# ADR-019 — Velha\n\n- Estado: Substituída\n- Data: 2026-09-01\n- Substituida por: ADR-022-nova\n')
  const nova = doc('ADR-022-nova', '# ADR-022 — Nova\n\n- Estado: Aceita\n- Data: 2026-09-02\n- Substitui: ADR-019-velha\n')
  ok('elo de duas pernas passa', collectionFindings([velha, nova]).length === 0)
  const novaMuda = doc('ADR-022-nova', '# ADR-022 — Nova\n\n- Estado: Aceita\n- Data: 2026-09-02\n')
  ok('elo de uma perna so reprova', collectionFindings([velha, novaMuda]).length === 1)
  ok('destino inexistente reprova', collectionFindings([velha]).length === 1)

  const a = doc('ADR-038-a', '# ADR-038 — A\n\n- Estado: Aceita\n- Data: 2026-09-06\n- Numero compartilhado com: ADR-038-b\n')
  const b = doc('ADR-038-b', '# ADR-038 — B\n\n- Estado: Aceita\n- Data: 2026-09-06\n- Numero compartilhado com: ADR-038-a\n')
  ok('numero compartilhado declarado dos dois lados passa', collectionFindings([a, b]).length === 0)
  const bMudo = doc('ADR-038-b', '# ADR-038 — B\n\n- Estado: Aceita\n- Data: 2026-09-06\n')
  ok('numero compartilhado nao declarado reprova', collectionFindings([a, bMudo]).length === 1)
  ok('numero compartilhado e detectado', sharedNumbers([a, b]).join() === '038')
  ok('numero unico nao e compartilhado', sharedNumbers([velha, nova]).length === 0)

  ok('citacao ambigua reprova', citationFindings('x.ts', 'ver a ADR-038 para isso', ['038']).length === 1)
  ok('citacao pelo nome completo passa', citationFindings('x.ts', 'ver ADR-038-immutable-staging-core', ['038']).length === 0)
  ok('citacao de numero unico passa', citationFindings('x.ts', 'ver a ADR-012', ['038']).length === 0)
  ok('sem numero ambiguo nada reprova', citationFindings('x.ts', 'ver a ADR-038', []).length === 0)
  ok('a saida explicita isenta o arquivo', citationFindings('x.md', `ver ADR-038\n<!-- ${ESCAPE} -->`, ['038']).length === 0)
  ok('sem a saida o mesmo texto reprova', citationFindings('x.md', 'ver ADR-038', ['038']).length === 1)
  ok('titulo da propria ADR nao e citacao', citationFindings('docs/adr/x.md', '# ADR-038 — Coisa', ['038']).length === 0)
  ok('errata no titulo passa', doc('ADR-002-e', '# ADR-002 / Errata E2 — Coisa\n\n- Estado: Aceita\n- Data: 2026-09-02\n').findings.length === 0)

  ok('resolve pelo nome completo', resolveCitation([a, b], 'ADR-038-a').decision === a)
  ok('numero compartilhado NAO resolve', resolveCitation([a, b], 'ADR-038').decision === null)
  ok('numero compartilhado diz o porque', resolveCitation([a, b], 'ADR-038').reason.includes('ADR-038-a'))
  ok('numero unico resolve', resolveCitation([velha, nova], 'ADR-022').decision === nova)
  ok('numero inexistente nao resolve', resolveCitation([velha], 'ADR-777').decision === null)
  return checks
}

/** Executa o portão e imprime o veredito. */
async function main() {
  if (process.argv.includes('--self-test')) {
    console.log(`DECISION_RECORD_SELF_TEST=PASS checks=${String(selfTest().length)}`)
    return
  }

  const decisions = await readDecisions()
  const findings = [...decisions.flatMap(decision => decision.findings), ...collectionFindings(decisions)]
  const ambiguous = sharedNumbers(decisions)
  let escapes = 0
  for (const path of trackedFiles()) {
    const source = await readFile(path, 'utf8')
    if (source.includes(ESCAPE)) escapes += 1
    findings.push(...citationFindings(path, source, ambiguous))
  }

  for (const finding of findings) console.error(finding)
  const state = findings.length === 0 ? 'PASS' : 'FAIL'
  const counts = Object.fromEntries(STATES.map(value => [value, decisions.filter(d => d.state === value).length]))
  const resumo = STATES.map(value => `${value}=${String(counts[value])}`).join(' ')
  console.log(`DECISION_RECORD=${state} decisoes=${String(decisions.length)} ${resumo} numeros_compartilhados=${String(ambiguous.length)} saidas_explicitas=${String(escapes)} achados=${String(findings.length)}`)
  if (findings.length > 0) process.exitCode = 1
}

await main()
