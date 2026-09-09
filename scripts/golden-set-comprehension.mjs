/**
 * O conjunto de briefs leigos, medido no ÚNICO ponto que dá para medir aqui:
 * o Studio entendeu o que a pessoa escreveu?
 *
 * ## Por que este teste existe
 *
 * O `run-golden-set.ts` percorre os 21 briefs e gera cada aplicativo — mas com
 * uma AppSpec montada dentro do próprio roteiro, por categoria. Ele prova que o
 * gerador de cada categoria roda; **não** prova que o texto da pessoa leva à
 * categoria certa. O brief entrava e era usado só para conferir comprimento.
 *
 * E é exatamente aí que o produto encontra quem não programa. A primeira tela
 * pede "conte com suas palavras o que você precisa", e o palpite de categoria
 * decide o que vai ser construído. Errar aqui não produz um app com defeito:
 * produz **o app errado** — a pessoa pede uma agenda e recebe uma página de
 * apresentação, depois de esperar a criação inteira.
 *
 * ## O que ele mede, e o que não mede
 *
 * MEDE: acerto do palpite determinístico sobre os 21 briefs, e o que ele
 * declara ter ENTENDIDO. Não custa nada, não chama modelo, não sai da máquina,
 * e roda em milissegundos — pode estar na CI sem credencial nenhuma.
 *
 * NÃO MEDE: se o aplicativo gerado atende os critérios. Isso continua exigindo
 * LLM real e ingresso do builder, e continua `NOT_EXECUTED` no relatório do
 * outro roteiro. Este arquivo não substitui aquele; ele cobre a metade que
 * estava sem nenhuma medição.
 *
 * Uso: node scripts/golden-set-comprehension.mjs [--self-test]
 */
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd()
/**
 * DOIS conjuntos, e a diferença entre eles é o ponto.
 *
 * `golden-set/` é onde o vocabulário foi AJUSTADO: os sinais de categoria
 * foram ampliados olhando estes 21 casos, então 100% aqui não prova nada
 * sozinho — prova que a lição foi decorada.
 *
 * `golden-set/holdout/` foi escrito DEPOIS do ajuste, com outras palavras, e
 * NUNCA foi usado para mexer nos sinais. É o número dele que diz se o produto
 * entende quem não programa ou se ele decorou 21 frases.
 *
 * Aviso que fica: os dois conjuntos foram escritos pela MESMA mão. Um vício de
 * vocabulário meu aparece nos dois, e nenhum deles substitui uma pessoa leiga
 * de verdade escrevendo do jeito dela (U-04, que continua em aberto).
 */
const SETS = [
  { name: 'ajuste', briefs: resolve(root, 'golden-set/briefs'), criteria: resolve(root, 'golden-set/criteria') },
  { name: 'cego', briefs: resolve(root, 'golden-set/holdout/briefs'), criteria: resolve(root, 'golden-set/holdout/criteria') },
]

/**
 * Dois números, e eles não valem a mesma coisa.
 *
 * ACERTO é quantas vezes o palpite bateu. O requisito pede >=80%, e ele é
 * cobrado no conjunto de AJUSTE — onde o vocabulário foi ampliado olhando os
 * casos, então ele mede memória, não compreensão.
 *
 * ERRO COM CONFIANÇA é quantas vezes o palpite afirmou ter entendido E errou.
 * Este é o número que machuca: quando o Studio não entende, a tela DIZ que não
 * entendeu e pede para a pessoa escolher — o custo é uma pergunta. Quando ele
 * entende errado, a pessoa espera a criação inteira para receber outro
 * aplicativo. Por isso o piso do conjunto CEGO é sobre erro com confiança, e
 * não sobre acerto: exigir 80% de acerto às cegas só me faria ampliar o
 * vocabulário até o número subir, que é a mesma memorização com mais passos.
 */
const ACCURACY_FLOOR = 0.8
/** Teto de erro com confiança no conjunto cego. */
const CONFIDENT_ERROR_CEILING = 0.25
/** Casos mínimos por categoria, o mesmo piso do outro roteiro. */
const PER_CATEGORY_FLOOR = 3

/**
 * O palpite, importado do MESMO módulo que a tela usa.
 *
 * Reimplementar a heurística aqui mediria uma cópia — e uma cópia passa a
 * concordar com o original só até alguém mexer num dos dois.
 */
const { categoryGuess } = await import(resolve(root, 'apps/studio-web/src/categorySuggestion.ts'))

/** O texto do brief sem o título em Markdown: a pessoa não escreve título. */
export function briefText(markdown) {
  return markdown.split('\n').filter(line => !line.startsWith('#')).join(' ').trim()
}

/** Percorre um conjunto e devolve acerto por caso. */
export async function measure(set) {
  const files = (await readdir(set.criteria)).filter(name => name.endsWith('.yml')).sort()
  const rows = []
  for (const file of files) {
    const criterion = JSON.parse(await readFile(resolve(set.criteria, file), 'utf8'))
    const markdown = await readFile(resolve(set.briefs, `${criterion.id}.md`), 'utf8')
    const text = briefText(markdown)
    const guess = categoryGuess(text)
    rows.push({
      id: criterion.id, expected: criterion.category, guessed: guess.category,
      understood: guess.understood, basis: guess.basis,
      hit: guess.category === criterion.category,
    })
  }
  return rows
}

if (process.argv.includes('--self-test')) {
  // O roteiro tem de reprovar quando o conjunto piora. Um medidor que só
  // conta acertos e nunca reprova é um número bonito pendurado na parede.
  const checks = []
  const fake = [{ hit: true }, { hit: true }, { hit: false }, { hit: false }, { hit: false }]
  checks.push(verdict(fake, {}).ok === false)
  checks.push(verdict([{ hit: true }, { hit: true }, { hit: true }, { hit: true }, { hit: true }], {}).ok === true)
  // No conjunto cego o que reprova é ERRAR COM CONFIANÇA. Um erro que a tela
  // admite - "não entendi, escolha aqui" - custa uma pergunta; um erro
  // afirmado custa a criação inteira.
  const humble = [{ hit: false, understood: false }, { hit: false, understood: false }, { hit: true, understood: true }, { hit: true, understood: true }]
  checks.push(verdict(humble, {}, true).ok === true)
  const cocky = [{ hit: false, understood: true }, { hit: false, understood: true }, { hit: true, understood: true }, { hit: true, understood: true }]
  checks.push(verdict(cocky, {}, true).ok === false)
  checks.push(briefText('# Título\ncorpo do brief') === 'corpo do brief')
  checks.push(briefText('sem titulo nenhum') === 'sem titulo nenhum')
  if (checks.some(value => value !== true)) { process.stderr.write('GOLDEN_COMPREHENSION_SELF_TEST=FAIL\n'); process.exit(1) }
  process.stdout.write(`GOLDEN_COMPREHENSION_SELF_TEST=PASS checks=${String(checks.length)}\n`)
  process.exit(0)
}

/** O veredito, separado para o auto-teste poder exercitá-lo sem ler disco. */
export function verdict(rows, byCategory, blind = false) {
  const hits = rows.filter(row => row.hit).length
  const accuracy = rows.length === 0 ? 0 : hits / rows.length
  const confidentErrors = rows.filter(row => !row.hit && row.understood).length
  const confidentRate = rows.length === 0 ? 0 : confidentErrors / rows.length
  const thin = Object.entries(byCategory).filter(([, count]) => count < PER_CATEGORY_FLOOR)
  const met = blind ? confidentRate <= CONFIDENT_ERROR_CEILING : accuracy >= ACCURACY_FLOOR
  return { ok: met && thin.length === 0, hits, accuracy, confidentErrors, confidentRate, thin }
}

let allOk = true
let blindAccuracy = 1
const summary = []
for (const set of SETS) {
  const rows = await measure(set)
  const byCategory = {}
  for (const row of rows) byCategory[row.expected] = (byCategory[row.expected] ?? 0) + 1
  const result = verdict(rows, byCategory, set.name === 'cego')
  allOk = allOk && result.ok
  if (set.name === 'cego') blindAccuracy = result.accuracy
  for (const row of rows.filter(candidate => !candidate.hit)) {
    process.stdout.write(`ERRO [${set.name}] ${row.id}: esperava ${row.expected}, entendeu ${row.guessed} (base=${row.basis}, entendeu=${String(row.understood)})\n`)
  }
  summary.push([
    `${set.name}=${result.ok ? 'PASS' : 'FAIL'}`,
    `casos=${String(rows.length)}`,
    `acerto=${(result.accuracy * 100).toFixed(1)}%`,
    `categorias=${String(Object.keys(byCategory).length)}`,
    `entendidos=${String(rows.filter(row => row.understood).length)}`,
    `erro_com_confianca=${String(result.confidentErrors)}`,
    `taxa=${(result.confidentRate * 100).toFixed(1)}%`,
  ].join(' '))
}
process.stdout.write(`GOLDEN_COMPREHENSION=${allOk ? 'PASS' : 'FAIL'} piso=${(ACCURACY_FLOOR * 100).toFixed(0)}% ${summary.join(' | ')}\n`)
// O portão PASSA e o requisito NÃO está cumprido, e as duas coisas são
// verdade ao mesmo tempo. Esta linha existe para ninguém ler o `PASS` acima
// como "P-07 resolvido": o portão guarda o erro que custa caro (afirmar e
// errar); o requisito pede >=80% de acerto, e às cegas o número não chega lá.
// Um portão que escondesse essa diferença seria mais um número bonito.
if (blindAccuracy < ACCURACY_FLOOR) {
  process.stdout.write(`ACERTO_CEGO_ABAIXO_DO_PISO acerto=${(blindAccuracy * 100).toFixed(1)}% piso=${(ACCURACY_FLOOR * 100).toFixed(0)}% requisito=P-07\n`)
}
if (!allOk) process.exit(1)
