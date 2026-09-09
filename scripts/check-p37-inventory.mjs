#!/usr/bin/env node
/**
 * Portão dos inventários P37 de referência externa.
 *
 * O prompt mestre exige um P37 específico ANTES de qualquer cópia de código de
 * terceiro. Um inventário só serve a esse propósito enquanto ninguém puder
 * declarar "revisado" deixando em branco justamente o campo que decidiria a
 * questão - licença, marca, segredo. Este portão recusa as duas formas de
 * branco: a ausência do campo e o travessão que finge preenchimento.
 *
 * Uso: node scripts/check-p37-inventory.mjs [--self-test]
 */
import { readFile, readdir } from 'node:fs/promises'

/** Onde os inventários moram. Um caminho fixo evita "passei em outro diretório". */
const DIRECTORY = 'docs/inventory/p37'

/**
 * Os seis requisitos REF-* do ledger, pelo slug do arquivo.
 *
 * A lista é fechada de propósito: sem ela, apagar um inventário inteiro faria o
 * portão passar com cinco arquivos válidos, que é exatamente a regressão que
 * este portão existe para impedir.
 */
export const REQUIRED_SLUGS = [
  'lovable', 'boltnew-boltdiy', 'v0', 'replit-agent-devin', 'zed', 'aider-claude-code-cline',
  // A skill entrou no repositorio: o inventario dela nao pode sumir depois.
  'ui-ux-pro-max-skill',
  // WebMCP: nada e copiado, mas a referencia externa existe e o inventario dela
  // e o que registra a decisao de seguranca tomada antes de escrever a primeira
  // linha. Apagar o inventario apagaria a decisao.
  'webmcp',
  // ARTEMIS: ferramenta externa de QA avaliada para a prova do D-09. Nada e
  // copiado, mas a decisao de seguranca (aparelho dedicado, capturas saindo
  // para um modelo externo) mora neste inventario.
  'artemis',
]

/**
 * Campos obrigatórios de todo inventário.
 *
 * Cada um responde a uma pergunta que, sem resposta escrita, vira suposição na
 * hora da decisão de copiar: sob que licença, com que prova, o que a marca
 * permite, o que o projeto faz com rede, disco e segredo.
 */
export const REQUIRED_FIELDS = [
  'projeto', 'url', 'licenca', 'evidencia_licenca', 'redistribuivel', 'marcas',
  'dependencias_e_lockfiles', 'rede_filesystem_segredos', 'cves_conhecidas',
  'sbom', 'sast', 'poc_isolado', 'veredito', 'data_da_consulta',
]

/**
 * A resposta honesta para o que não foi confirmado na fonte.
 *
 * É ACEITA porque um campo em branco e um campo inventado são piores: o branco
 * esconde a lacuna, a invenção a preenche com ficção. O que o portão exige é
 * que a lacuna venha acompanhada do motivo - ver `unverifiedWithoutReason`.
 */
const UNVERIFIED = 'NAO_VERIFICADO'

/**
 * Valores que ocupam a linha sem dizer nada. O travessão é o caso que motivou
 * este portão: ele passa em qualquer revisão visual e não informa nada.
 */
const EMPTY_VALUES = new Set(['', '—', '–', '-', '--', 'n/a', 'na', 'tbd', 'todo', '?', '...'])

/**
 * Lê os pares `- campo: valor` de um inventário.
 *
 * O formato é uma linha por campo, deliberadamente: valor multilinha permitiria
 * que um campo terminasse vazio com a continuação do campo anterior parecendo
 * conteúdo dele.
 * @param source - conteúdo do arquivo markdown.
 * @returns os campos na ordem do arquivo, com nome e valor já sem espaço.
 */
export function parseInventory(source) {
  const entries = []
  for (const line of source.split('\n')) {
    const match = /^[-*]\s+(?:\*\*)?([a-z0-9_]+)(?:\*\*)?\s*:\s*(.*)$/u.exec(line)
    if (match === null) continue
    entries.push({ field: match[1], value: match[2].trim() })
  }
  return entries
}

/** Uma célula que não diz nada: vazia, travessão, ou marcador de pendência. */
function empty(value) {
  return EMPTY_VALUES.has(value.trim().toLowerCase())
}

/**
 * `NAO_VERIFICADO` sozinho, sem o motivo.
 *
 * Sem esta regra o token viraria o novo travessão: uma palavra que passa no
 * portão e não permite a ninguém julgar se a lacuna é aceitável ou bloqueante.
 */
function unverifiedWithoutReason(value) {
  const trimmed = value.trim()
  if (!trimmed.startsWith(UNVERIFIED)) return false
  const rest = trimmed.slice(UNVERIFIED.length).replace(/^[\s—–:.-]+/u, '')
  return rest.length < 12
}

/**
 * Todos os problemas de um inventário, em ordem de leitura.
 * @param slug - nome do arquivo sem extensão, usado no prefixo das mensagens.
 * @param entries - os campos já interpretados.
 * @returns as mensagens de reprovação.
 */
export function inventoryFindings(slug, entries) {
  const findings = []
  const values = new Map()
  for (const entry of entries) {
    if (!REQUIRED_FIELDS.includes(entry.field)) continue
    // Campo repetido é ambíguo: duas respostas diferentes para a mesma pergunta
    // deixam o leitor escolher a que lhe convém.
    if (values.has(entry.field)) findings.push(`${slug}: campo repetido "${entry.field}"`)
    else values.set(entry.field, entry.value)
  }
  for (const field of REQUIRED_FIELDS) {
    if (!values.has(field)) { findings.push(`${slug}: campo obrigatório ausente "${field}"`); continue }
    const value = values.get(field)
    if (empty(value)) {
      findings.push(`${slug}: campo "${field}" vazio ou preenchido com travessão — escreva ${UNVERIFIED} e o motivo`)
      continue
    }
    if (unverifiedWithoutReason(value)) {
      findings.push(`${slug}: campo "${field}" diz ${UNVERIFIED} sem dizer POR QUE não foi verificado`)
    }
  }
  const url = values.get('url') ?? ''
  // Uma referência externa sem endereço não é rastreável até a fonte, que é a
  // única coisa que distingue este inventário de uma lembrança.
  if (url !== '' && !empty(url) && !/https?:\/\//u.test(url)) {
    findings.push(`${slug}: campo "url" não contém um endereço http(s) verificável`)
  }
  const redistribution = (values.get('redistribuivel') ?? '').toLowerCase()
  // "Pode redistribuir?" é uma decisão, não uma dissertação: o veredito tem de
  // aparecer na primeira palavra, senão a linha vira texto que cada um lê como quer.
  if (redistribution !== '' && !/^(sim|não|nao|parcial|nao_verificado)\b/u.test(redistribution)) {
    findings.push(`${slug}: campo "redistribuivel" precisa começar por sim/não/parcial/${UNVERIFIED}`)
  }
  const consulted = values.get('data_da_consulta') ?? ''
  // Um inventário sem data não permite saber se a licença lida ainda é a atual.
  if (consulted !== '' && !/^\d{4}-\d{2}-\d{2}$/u.test(consulted.trim())) {
    findings.push(`${slug}: campo "data_da_consulta" precisa ser uma data ISO AAAA-MM-DD`)
  }
  return findings
}

/**
 * Confere que nenhum dos seis requisitos ficou sem arquivo.
 * @param slugs - os slugs encontrados no diretório.
 * @returns as mensagens de reprovação.
 */
export function missingSlugFindings(slugs) {
  const present = new Set(slugs)
  return REQUIRED_SLUGS.filter(slug => !present.has(slug))
    .map(slug => `${slug}: inventário P37 exigido pelo ledger NÃO EXISTE em ${DIRECTORY}/`)
}

function selfTest() {
  const good = REQUIRED_FIELDS.map(field => ({
    field,
    value: field === 'url' ? 'https://exemplo.invalid/'
      : field === 'redistribuivel' ? 'não — licença proprietária'
        : field === 'data_da_consulta' ? '2026-09-08'
          : 'conteúdo real verificado na fonte',
  }))
  const without = field => good.filter(entry => entry.field !== field)
  const replace = (field, value) => good.map(entry => (entry.field === field ? { field, value } : entry))
  const checks = [
    ['inventário completo passa', inventoryFindings('x', good).length === 0],
    ['campo ausente reprova', inventoryFindings('x', without('licenca')).length > 0],
    ['campo vazio reprova', inventoryFindings('x', replace('marcas', '')).length > 0],
    ['travessão reprova', inventoryFindings('x', replace('sbom', '—')).length > 0],
    ['hífen reprova', inventoryFindings('x', replace('sast', '-')).length > 0],
    ['TODO reprova', inventoryFindings('x', replace('cves_conhecidas', 'TODO')).length > 0],
    ['NAO_VERIFICADO com motivo passa', inventoryFindings('x', replace('sbom', 'NAO_VERIFICADO — motivo: o fornecedor não publica SBOM')).length === 0],
    ['NAO_VERIFICADO sem motivo reprova', inventoryFindings('x', replace('sbom', 'NAO_VERIFICADO')).length > 0],
    ['url sem http reprova', inventoryFindings('x', replace('url', 'procurar no google')).length > 0],
    ['redistribuivel sem veredito reprova', inventoryFindings('x', replace('redistribuivel', 'depende do caso')).length > 0],
    ['data não-ISO reprova', inventoryFindings('x', replace('data_da_consulta', 'setembro de 2026')).length > 0],
    ['campo repetido reprova', inventoryFindings('x', [...good, { field: 'licenca', value: 'outra coisa' }]).length > 0],
    ['inventário faltando reprova', missingSlugFindings(REQUIRED_SLUGS.slice(1)).length > 0],
    ['seis inventários presentes passam', missingSlugFindings(REQUIRED_SLUGS).length === 0],
    ['parser lê o formato do arquivo', parseInventory('- projeto: Zed\n- url: https://zed.dev/\ntexto solto').length === 2],
  ]
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name)
  console.log(`P37_INVENTORY_SELF_TEST=${failed.length === 0 ? 'PASS' : 'FAIL'} checks=${String(checks.length)}${failed.length === 0 ? '' : ` falhou=${failed.join(', ')}`}`)
  return failed.length === 0
}

if (process.argv.includes('--self-test')) {
  process.exitCode = selfTest() ? 0 : 1
} else {
  const files = await readdir(DIRECTORY).catch(() => [])
  const slugs = files.filter(name => name.endsWith('.md')).map(name => name.slice(0, -3)).sort()
  const findings = missingSlugFindings(slugs)
  for (const slug of slugs) {
    const source = await readFile(`${DIRECTORY}/${slug}.md`, 'utf8')
    const entries = parseInventory(source)
    // Um arquivo sem nenhum campo reconhecido é um rascunho, não um inventário:
    // sem esta linha ele passaria calado como "nada a reprovar".
    if (entries.length === 0) findings.push(`${slug}: nenhum campo foi lido — o arquivo não segue o formato "- campo: valor"`)
    findings.push(...inventoryFindings(slug, entries))
  }
  for (const finding of findings) console.error(finding)
  console.log(`P37_INVENTORY=${findings.length === 0 ? 'PASS' : 'FAIL'} inventarios=${String(slugs.length)}/${String(REQUIRED_SLUGS.length)} campos=${String(REQUIRED_FIELDS.length)} achados=${String(findings.length)}`)
  process.exitCode = findings.length === 0 ? 0 : 1
}
