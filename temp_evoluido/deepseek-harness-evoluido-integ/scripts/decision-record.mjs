/**
 * O registro de decisões, lido por máquina.
 *
 * As cinquenta ADRs em `docs/adr/` são o único lugar onde está escrito o que
 * este projeto decidiu e por quê. Mesmo assim, nada as lê: o estado de cada uma
 * aparecia em SEIS sintaxes diferentes (`- Status:`, `Status:`, `**Status:**`,
 * `## Status`, `## Estado`, e `Data: … Estado: … Autor: …` na mesma linha), e
 * o próprio NÚMERO deixou de identificar — `ADR-038` nomeia três decisões
 * distintas e `ADR-034` nomeia duas.
 *
 * Isso não é questão de arrumação. Havia SETE citações vivas na árvore apontando
 * para um número compartilhado — em `docs/CAPABILITY_MATRIX.md`, no livro mestre
 * de requisitos, no perfil `cordis.patch.yml` que MONTA o plugin, no README do
 * builder-supervisor, no comentário de `plugins/staging/src/repository.ts` e
 * dentro de duas ADRs. Quem seguisse qualquer uma chegava a uma pasta com três
 * respostas e nenhuma forma de saber qual era a certa. Uma decisão que não se
 * consegue citar não está registrada.
 *
 * Este módulo é a MEMÓRIA DE DECISÃO no sentido estrito da missão: ele guarda o
 * que foi decidido, com a ressalva exatamente como foi escrita, e não conclui
 * nada. A identidade é o `slug` — o nome do arquivo sem `.md` —, que é único por
 * construção do sistema de arquivos; o número continua sendo rótulo humano.
 *
 * DECISÃO ASSUMIDA: os números duplicados NÃO foram renumerados —
 * justificativa: renumerar reescreve o identificador pelo qual Prado se refere
 * a estas decisões fora deste repositório, e o defeito real (uma citação que
 * não resolve) fecha inteiro exigindo que a citação nomeie o slug. A ADR que
 * compartilha número passa a DECLARAR com quem o compartilha, e o portão recusa
 * citação ambígua.
 * Este arquivo escreve numeros ambiguos DE PROPOSITO: citacao-ambigua-proposital
 */
import { readFile, readdir } from 'node:fs/promises'

export const ADR_DIRECTORY = 'docs/adr'

/**
 * Os estados possíveis de uma decisão.
 *
 * Lista fechada: um estado livre é o que produziu as seis sintaxes. `Aceita`
 * quer dizer que vale agora; `Substituída`, que outra decisão tomou o lugar
 * desta; `Proposta`, que foi escrita e ainda não vale; `Rejeitada`, que foi
 * considerada e recusada — e que continua aqui porque apagar a recusa faz a
 * mesma proposta voltar daqui a três meses sem ninguém lembrar do motivo.
 */
export const STATES = ['Aceita', 'Substituída', 'Proposta', 'Rejeitada']

const SLUG = /^ADR-(\d{3})-[a-z0-9][a-z0-9-]*$/u

/**
 * Lê os pares `- campo: valor` do cabeçalho de uma ADR.
 *
 * Só o cabeçalho: a leitura para na primeira linha `## `, porque o corpo de uma
 * ADR é prosa e lá dentro há listas com dois-pontos que não são campos.
 * @param source - o conteúdo do arquivo.
 * @returns os campos na ordem em que aparecem.
 */
export function parseHeader(source) {
  const fields = []
  for (const line of source.split('\n')) {
    if (line.startsWith('## ')) break
    const match = /^-\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ ]*?)\s*:\s*(.*)$/u.exec(line)
    if (match === null) continue
    fields.push({ field: match[1].trim(), value: match[2].trim() })
  }
  return fields
}

/**
 * Uma decisão, na forma que uma máquina consegue consultar.
 * @param slug - o nome do arquivo sem `.md`; é a identidade.
 * @param source - o conteúdo do arquivo.
 * @returns a decisão interpretada, com `findings` não vazio quando não dá para confiar nela.
 */
export function parseDecision(slug, source) {
  const findings = []
  const slugMatch = SLUG.exec(slug)
  if (slugMatch === null) {
    return { slug, number: null, title: null, state: null, caveat: null, date: null, supersededBy: null, supersedes: [], sharesNumberWith: [], findings: [`${slug}: nome de arquivo fora do padrao ADR-NNN-slug-em-minusculas`] }
  }
  const number = slugMatch[1]
  const titleLine = source.split('\n').find(line => line.startsWith('# ')) ?? ''
  // O `/ Errata EN` de tres ADRs faz parte do titulo e NAO e ruido: apaga-lo
  // para caber no padrao trocaria informacao real por conformidade.
  const titleMatch = /^#\s+ADR-(\d{3})(?:\s*\/\s*[^—]+?)?\s+—\s+(.+)$/u.exec(titleLine)
  if (titleMatch === null) findings.push(`${slug}: titulo fora do padrao "# ADR-NNN — Titulo"`)
  else if (titleMatch[1] !== number) findings.push(`${slug}: o titulo diz ADR-${titleMatch[1]} e o arquivo diz ADR-${number}`)

  const header = parseHeader(source)
  const value = name => {
    const found = header.filter(entry => entry.field === name)
    if (found.length > 1) findings.push(`${slug}: campo "${name}" repetido no cabecalho`)
    return found[0]?.value
  }
  const list = name => {
    const raw = value(name)
    return raw === undefined ? [] : raw.split(',').map(part => part.trim()).filter(part => part !== '')
  }

  const state = value('Estado')
  if (state === undefined) findings.push(`${slug}: cabecalho sem "- Estado:"`)
  else if (!STATES.includes(state)) findings.push(`${slug}: estado "${state}" fora da lista fechada (${STATES.join(', ')})`)

  const date = value('Data')
  if (date === undefined) findings.push(`${slug}: cabecalho sem "- Data:"`)
  else if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) findings.push(`${slug}: data "${date}" nao esta em AAAA-MM-DD`)

  const caveat = value('Ressalva') ?? null
  const supersededBy = value('Substituida por') ?? null
  const supersedes = list('Substitui')
  const sharesNumberWith = list('Numero compartilhado com')

  // Uma decisao substituida SEM apontar quem a substituiu e a pior das formas:
  // ela diz "nao me siga" e nao diz para onde ir.
  if (state === 'Substituída' && supersededBy === null) {
    findings.push(`${slug}: estado Substituida sem "- Substituida por:" — nao diz qual decisao tomou o lugar`)
  }
  if (state !== 'Substituída' && supersededBy !== null) {
    findings.push(`${slug}: declara "Substituida por" mas o estado e "${String(state)}"`)
  }
  return { slug, number, title: titleMatch?.[2] ?? null, state: state ?? null, caveat, date: date ?? null, supersededBy, supersedes, sharesNumberWith, findings }
}

/**
 * Lê todas as decisões do disco.
 * @param directory - a pasta das ADRs.
 * @returns as decisões, em ordem de nome.
 */
export async function readDecisions(directory = ADR_DIRECTORY) {
  const names = (await readdir(directory)).filter(name => name.endsWith('.md')).sort()
  return Promise.all(names.map(async name => parseDecision(name.slice(0, -3), await readFile(`${directory}/${name}`, 'utf8'))))
}

/**
 * Os problemas do CONJUNTO, que nenhuma decisão isolada consegue ver.
 *
 * São três, e os três já aconteceram nesta árvore: um número que nomeia mais de
 * uma decisão sem que nenhuma delas declare o compartilhamento; uma substituição
 * que aponta para uma decisão inexistente ou que não reconhece a substituição de
 * volta (o elo de uma perna só deixa a decisão antiga parecendo válida quando se
 * chega nela pelo outro lado); e uma declaração de número compartilhado que não
 * bate com a realidade do disco.
 * @param decisions - as decisões já interpretadas.
 * @returns as mensagens de reprovação.
 */
export function collectionFindings(decisions) {
  const findings = []
  const bySlug = new Map(decisions.map(decision => [decision.slug, decision]))
  const byNumber = new Map()
  for (const decision of decisions) {
    if (decision.number === null) continue
    byNumber.set(decision.number, [...(byNumber.get(decision.number) ?? []), decision.slug])
  }

  for (const [number, slugs] of byNumber) {
    if (slugs.length === 1) continue
    for (const slug of slugs) {
      const declared = [...bySlug.get(slug).sharesNumberWith].sort()
      const real = slugs.filter(other => other !== slug).sort()
      if (declared.join('|') !== real.join('|')) {
        findings.push(`ADR-${number}: ${slug} nao declara corretamente com quem compartilha o numero (declara [${declared.join(', ')}], o disco diz [${real.join(', ')}])`)
      }
    }
  }

  for (const decision of decisions) {
    if (decision.supersededBy !== null) {
      const target = bySlug.get(decision.supersededBy)
      if (target === undefined) findings.push(`${decision.slug}: "Substituida por: ${decision.supersededBy}" aponta para uma decisao que nao existe`)
      else if (!target.supersedes.includes(decision.slug)) {
        findings.push(`${decision.slug}: ${decision.supersededBy} nao declara "Substitui: ${decision.slug}" — o elo tem uma perna so`)
      }
    }
    for (const superseded of decision.supersedes) {
      const target = bySlug.get(superseded)
      if (target === undefined) findings.push(`${decision.slug}: "Substitui: ${superseded}" aponta para uma decisao que nao existe`)
      else if (target.supersededBy !== decision.slug) {
        findings.push(`${decision.slug}: ${superseded} nao declara "Substituida por: ${decision.slug}" — o elo tem uma perna so`)
      }
    }
  }
  return findings
}

/**
 * Os números que nomeiam mais de uma decisão.
 * @param decisions - as decisões já interpretadas.
 * @returns os números ambíguos.
 */
export function sharedNumbers(decisions) {
  const counts = new Map()
  for (const decision of decisions) {
    if (decision.number === null) continue
    counts.set(decision.number, (counts.get(decision.number) ?? 0) + 1)
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([number]) => number).sort()
}

/**
 * Resolve uma citação para a decisão que ela nomeia.
 *
 * É o que qualquer consumidor futuro desta memória precisa e é onde está a
 * regra: um número compartilhado NÃO resolve. Devolver "a primeira" seria pior
 * do que não resolver — quem chamasse receberia uma decisão de verdade, com
 * texto plausível, e não teria como saber que era a errada.
 * @param decisions - as decisões já interpretadas.
 * @param citation - `ADR-038` ou `ADR-038-immutable-staging-core`.
 * @returns a decisão, ou o motivo pelo qual a citação não resolve.
 */
export function resolveCitation(decisions, citation) {
  const bySlug = decisions.find(decision => decision.slug === citation)
  if (bySlug !== undefined) return { decision: bySlug, reason: null }
  const number = /^ADR-(\d{3})$/u.exec(citation)?.[1]
  if (number === undefined) return { decision: null, reason: `"${citation}" nao tem a forma de uma citacao de ADR` }
  const matches = decisions.filter(decision => decision.number === number)
  if (matches.length === 0) return { decision: null, reason: `ADR-${number} nao existe` }
  if (matches.length > 1) {
    return { decision: null, reason: `ADR-${number} nomeia ${String(matches.length)} decisoes (${matches.map(m => m.slug).join(', ')}); cite o nome completo` }
  }
  return { decision: matches[0], reason: null }
}
