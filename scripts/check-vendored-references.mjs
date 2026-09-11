#!/usr/bin/env node
/**
 * Portão das referências externas copiadas em `vendor/`.
 *
 * A pasta `vendor/` faz três afirmações que, sem verificação, são só prosa:
 * que cada cópia carrega a licença do titular, que cada uma diz de onde e de
 * qual commit veio, e que NADA ali é dependência do produto. A terceira é a que
 * mais importa: uma cópia que silenciosamente entra na topologia pnpm vira
 * dependência de release sem ninguém decidir isso.
 *
 * E há uma quarta, específica do ECC: `assets/` ficou de fora porque guarda
 * marca de terceiro que o MIT do projeto não podia licenciar. Uma cópia futura
 * feita sem ler o PROVENANCE traria a pasta de volta, e o repositório público
 * passaria a distribuir logotipo alheio. Este portão recusa esse retorno.
 *
 * Uso: node scripts/check-vendored-references.mjs [--self-test]
 */
import { readFile, readdir, stat } from 'node:fs/promises'

const DIRECTORY = 'vendor'

/**
 * As cópias esperadas, pelo nome da pasta.
 *
 * Lista fechada de propósito: sem ela, apagar uma cópia inteira faria o portão
 * passar com duas pastas válidas — que é a regressão que ele existe para pegar.
 */
export const REQUIRED_VENDORS = ['ecc', 'mattpocock-skills', 'spec-kit']

/** Campos que todo PROVENANCE.md precisa responder. */
export const REQUIRED_FIELDS = ['origem', 'commit', 'data_do_commit', 'copiado_em', 'licenca', 'inventario', 'decisao']

/**
 * Caminhos proibidos dentro de uma cópia.
 *
 * `vendor/ecc/assets` é o caso real: logotipos de CodeRabbit, Greptile, Atlas
 * Cloud, Moonshot AI e Itô Markets, hospedados no ECC por patrocínio. O MIT de
 * Affaan Mustafa não os cobre.
 */
export const FORBIDDEN_PATHS = [
  { path: 'ecc/assets', reason: 'guarda logotipo de cinco empresas terceiras que o MIT do ECC nao licencia' },
]

/** Um commit de git de verdade: 40 hexadecimais, nem abreviado nem inventado. */
const FULL_SHA = /^[0-9a-f]{40}$/u

/** Valores que ocupam a linha sem dizer nada. */
const EMPTY_VALUES = new Set(['', '—', '–', '-', '--', 'n/a', 'na', 'tbd', 'todo', '?', '...'])

/**
 * Lê os pares `- campo: valor` de um PROVENANCE.md.
 * @param source - conteúdo do arquivo.
 * @returns os campos na ordem do arquivo.
 */
export function parseProvenance(source) {
  const entries = []
  for (const line of source.split('\n')) {
    const match = /^[-*]\s+(?:\*\*)?([a-z0-9_]+)(?:\*\*)?\s*:\s*(.*)$/u.exec(line)
    if (match === null) continue
    entries.push({ field: match[1], value: match[2].trim() })
  }
  return entries
}

/**
 * Todos os problemas de uma procedência, em ordem de leitura.
 * @param name - nome da pasta em vendor/.
 * @param entries - os campos já interpretados.
 * @returns as mensagens de reprovação.
 */
export function provenanceFindings(name, entries) {
  const findings = []
  const values = new Map()
  for (const entry of entries) {
    if (!REQUIRED_FIELDS.includes(entry.field)) continue
    if (values.has(entry.field)) findings.push(`${name}: campo repetido "${entry.field}" no PROVENANCE.md`)
    else values.set(entry.field, entry.value)
  }
  for (const field of REQUIRED_FIELDS) {
    const value = values.get(field)
    if (value === undefined) { findings.push(`${name}: PROVENANCE.md sem o campo "${field}"`); continue }
    if (EMPTY_VALUES.has(value.toLowerCase())) {
      findings.push(`${name}: campo "${field}" vazio ou preenchido com travessao`)
    }
  }
  const commit = values.get('commit')
  // Commit abreviado nao identifica: ele volta a ser ambiguo assim que a arvore
  // cresce, e a procedencia deixa de provar de onde a copia veio.
  if (commit !== undefined && !FULL_SHA.test(commit)) {
    findings.push(`${name}: commit "${commit}" nao e um SHA-1 completo de 40 hexadecimais`)
  }
  return findings
}

/**
 * Um caminho existe no disco?
 * @param path - caminho a testar.
 * @returns verdadeiro se existir.
 */
async function exists(path) {
  try { await stat(path); return true } catch { return false }
}

/**
 * Nenhuma cópia pode estar em nenhuma das duas topologias pnpm.
 *
 * A afirmação "isto não é dependência do produto" só vale enquanto for
 * verdadeira nos dois arquivos de workspace E nos dois lockfiles — e ela é
 * fácil de quebrar sem querer, com um glob generoso.
 *
 * A busca é pelo NOME de cada cópia, e não por `vendor/` solto. O motivo é
 * concreto e custou uma reprovação falsa: o Harness pinado tem um `vendor/`
 * PRÓPRIO (`third_party/deepseek-harness/vendor/cordis` e companhia), que está
 * na topologia por desenho e não tem nada a ver com estas cópias. Um portão que
 * grita por causa de uma pasta homônima do upstream ensina a ignorá-lo.
 * @param names - as cópias a procurar.
 * @returns as mensagens de reprovação.
 */
export async function topologyFindings(names = REQUIRED_VENDORS) {
  const findings = []
  const pattern = new RegExp(`(^|[\\s'"(:])vendor/(${names.join('|')})(?![\\w-])`, 'u')
  for (const file of ['pnpm-workspace.yaml', 'pnpm-workspace.release.yaml', 'pnpm-lock.yaml', 'pnpm-lock.release.yaml']) {
    if (!await exists(file)) continue
    const source = await readFile(file, 'utf8')
    for (const line of source.split('\n')) {
      // Comentario nao e topologia: ele explica, nao inclui.
      if (line.trimStart().startsWith('#')) continue
      if (pattern.test(line)) {
        findings.push(`${file} referencia uma copia de vendor/ — ela entrou na topologia do produto: "${line.trim()}"`)
      }
    }
  }
  return findings
}

/** Os auto-testes: cada regra provada contra um caso que DEVE reprovar. */
export function selfTest() {
  const checks = []
  const ok = (label, condition) => { checks.push(label); if (!condition) throw new Error(`auto-teste falhou: ${label}`) }
  const full = 'c9148d0bb239ed01a95724a5928b98cdf9c30658'
  const good = REQUIRED_FIELDS.map(f => `- ${f}: ${f === 'commit' ? full : 'valor real'}`).join('\n')

  ok('procedencia completa passa', provenanceFindings('x', parseProvenance(good)).length === 0)
  ok('campo ausente reprova', provenanceFindings('x', parseProvenance(good.split('\n').slice(1).join('\n'))).length === 1)
  ok('travessao reprova', provenanceFindings('x', parseProvenance(good.replace('- licenca: valor real', '- licenca: —'))).length === 1)
  ok('campo repetido reprova', provenanceFindings('x', parseProvenance(`${good}\n- licenca: outra`)).length === 1)
  ok('commit abreviado reprova', provenanceFindings('x', parseProvenance(good.replace(full, 'c9148d0'))).length === 1)
  ok('commit inventado reprova', provenanceFindings('x', parseProvenance(good.replace(full, 'z'.repeat(40)))).length === 1)
  ok('parser ignora prosa', parseProvenance('texto solto\n- origem: url').length === 1)
  ok('lista de copias e fechada', REQUIRED_VENDORS.length === 3)
  ok('assets do ecc esta proibido', FORBIDDEN_PATHS.some(p => p.path === 'ecc/assets'))

  // O falso positivo que este portao ja produziu uma vez, virado teste: o
  // `vendor/` do Harness pinado NAO pode ser confundido com estas copias.
  const topology = new RegExp(`(^|[\\s'"(:])vendor/(${REQUIRED_VENDORS.join('|')})(?![\\w-])`, 'u')
  ok('vendor do Harness nao reprova', !topology.test('      version: link:../../third_party/deepseek-harness/vendor/cordis'))
  ok('glob do Harness nao reprova', !topology.test('  - third_party/deepseek-harness/vendor/*'))
  ok('copia na topologia reprova', topology.test('  - vendor/ecc'))
  ok('prefixo parecido nao reprova', !topology.test('  - vendor/ecc-outra-coisa'))
  return checks
}

/** Executa o portão e imprime o veredito. */
async function main() {
  if (process.argv.includes('--self-test')) {
    const checks = selfTest()
    console.log(`VENDORED_REFERENCES_SELF_TEST=PASS checks=${checks.length}`)
    return
  }

  const findings = []
  const present = (await readdir(DIRECTORY, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name)

  for (const name of REQUIRED_VENDORS) {
    if (!present.includes(name)) {
      findings.push(`${name}: copia exigida NAO EXISTE em ${DIRECTORY}/`)
      continue
    }
    // Licenca ausente e o pior caso: a copia continua la, redistribuivel na
    // aparencia, sem o aviso que a licenca exige que acompanhe.
    if (!await exists(`${DIRECTORY}/${name}/LICENSE`)) {
      findings.push(`${name}: sem LICENSE — o MIT exige que o aviso acompanhe a copia`)
    }
    if (!await exists(`${DIRECTORY}/${name}/PROVENANCE.md`)) {
      findings.push(`${name}: sem PROVENANCE.md — ninguem sabe de qual commit esta copia veio`)
      continue
    }
    findings.push(...provenanceFindings(name, parseProvenance(await readFile(`${DIRECTORY}/${name}/PROVENANCE.md`, 'utf8'))))
  }

  for (const forbidden of FORBIDDEN_PATHS) {
    if (await exists(`${DIRECTORY}/${forbidden.path}`)) {
      findings.push(`${forbidden.path} VOLTOU: ${forbidden.reason}`)
    }
  }

  findings.push(...await topologyFindings())

  for (const finding of findings) console.error(finding)
  const state = findings.length === 0 ? 'PASS' : 'FAIL'
  console.log(`VENDORED_REFERENCES=${state} copias=${present.length}/${REQUIRED_VENDORS.length} campos=${REQUIRED_FIELDS.length} achados=${findings.length}`)
  if (findings.length > 0) process.exitCode = 1
}

await main()
