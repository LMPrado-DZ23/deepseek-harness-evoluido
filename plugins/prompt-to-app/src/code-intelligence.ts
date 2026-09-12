import ts from 'typescript'
import { t } from './i18n.js'

/**
 * O que já EXISTE no aplicativo gerado: arquivos, símbolos e quem depende de quem.
 *
 * Sem isto, um pedido de mudança é planejado às cegas. O planejador sabe o que
 * a pessoa quer e não sabe o que já está escrito — e o resultado conhecido é
 * um de dois: ou ele manda reescrever um arquivo que já fazia aquilo (e o
 * trabalho anterior some), ou ele cria um segundo arquivo com a mesma
 * responsabilidade (e a partir daí existem duas verdades).
 *
 * Três coisas, e a ordem importa:
 *
 * 1. **Índice**: quais arquivos existem. É o chão.
 * 2. **Símbolos**: o que cada arquivo EXPORTA. É o que permite responder "onde
 *    isso já existe?" antes de mandar criar de novo.
 * 3. **Grafo**: quem importa quem — e, lido ao contrário, quem QUEBRA se este
 *    arquivo mudar. É a pergunta que ninguém consegue responder de cabeça num
 *    aplicativo com trinta arquivos.
 *
 * O princípio que atravessa o arquivo: **arquivo ilegível é DITO, nunca
 * pulado**. Um arquivo que some do grafo é lido como "ninguém depende dele",
 * que é exatamente a conclusão que faz alguém apagá-lo com confiança.
 */

/** Um arquivo do aplicativo, como ele chega aqui. */
export interface SourceFileInput {
  /** Caminho RELATIVO à raiz do aplicativo, com barras normais. */
  readonly path: string
  readonly text: string
}

/** Um símbolo exportado por um arquivo. */
export interface ExportedSymbol {
  readonly name: string
  readonly kind: 'function' | 'class' | 'const' | 'type' | 'interface' | 'default' | 're-export'
}

/** Uma ligação de importação entre um arquivo e outra coisa. */
export interface ImportEdge {
  readonly from: string
  /** O texto do especificador, como está escrito no código. */
  readonly specifier: string
  /**
   * O arquivo apontado, quando ele existe no índice.
   *
   * `null` quando o especificador é EXTERNO (um pacote) ou aponta para fora do
   * índice. Os dois casos são diferentes de "não há importação", e por isso a
   * aresta continua existindo com `to: null` em vez de sumir: um pedido de
   * mudança que remove uma dependência externa precisa saber que ela estava lá.
   */
  readonly to: string | null
}

export interface CodeIndex {
  readonly files: readonly string[]
  readonly symbols: ReadonlyMap<string, readonly ExportedSymbol[]>
  readonly imports: readonly ImportEdge[]
  /**
   * Os arquivos que NÃO puderam ser lidos, com o motivo.
   *
   * Existe porque o contrário — sumir do índice — transforma um defeito de
   * leitura em uma afirmação falsa sobre o código.
   */
  readonly unreadable: readonly { readonly path: string; readonly reason: string }[]
}

/** Extensões que este índice sabe ler. */
const READABLE = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

/**
 * Se o caminho é de um arquivo que este índice sabe ler.
 * @param path - o caminho.
 * @returns se sabe.
 */
export function isReadableSource(path: string): boolean {
  return READABLE.some(extension => path.endsWith(extension))
}

/**
 * Monta o índice a partir dos arquivos do aplicativo.
 *
 * Arquivo que este índice não sabe ler (JSON, CSS, imagem) NÃO entra como
 * ilegível: ele não é um defeito, é outro tipo de arquivo. Ele entra no índice
 * de arquivos e não produz símbolo nem aresta — o que é a verdade sobre ele.
 * @param files - os arquivos do aplicativo.
 * @returns o índice.
 */
export function buildCodeIndex(files: readonly SourceFileInput[]): CodeIndex {
  const known = new Set(files.map(file => file.path))
  // Os apelidos de caminho vêm do `tsconfig.json` DO APLICATIVO, que está entre
  // os arquivos lidos. Ler o do Studio aqui seria descrever o projeto errado.
  const aliases = parsePathAliases(files.find(file => file.path === 'tsconfig.json')?.text ?? '')
  const symbols = new Map<string, readonly ExportedSymbol[]>()
  const imports: ImportEdge[] = []
  const unreadable: { path: string; reason: string }[] = []

  for (const file of files) {
    if (!isReadableSource(file.path)) continue
    let parsed: ts.SourceFile
    try {
      parsed = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, scriptKind(file.path))
    } catch (error) {
      unreadable.push({ path: file.path, reason: error instanceof Error ? error.message : 'parse' })
      continue
    }
    // `createSourceFile` NÃO lança em código inválido: ele produz uma árvore
    // com nós de erro. Perguntar pelos diagnósticos de sintaxe é o que
    // distingue "arquivo vazio de símbolos" de "arquivo que não compila".
    if (syntaxErrors(parsed) > 0) {
      unreadable.push({ path: file.path, reason: 'syntax' })
      continue
    }
    symbols.set(file.path, collectExports(parsed))
    for (const specifier of collectImports(parsed)) {
      imports.push({ from: file.path, specifier, to: resolveSpecifier(file.path, specifier, known, aliases) })
    }
  }

  return { files: files.map(file => file.path), symbols, imports, unreadable }
}

/** Quantos erros de sintaxe a árvore carrega. */
function syntaxErrors(parsed: ts.SourceFile): number {
  return (parsed as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics?.length ?? 0
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/** Os símbolos que um arquivo exporta. */
function collectExports(parsed: ts.SourceFile): readonly ExportedSymbol[] {
  const found: ExportedSymbol[] = []
  for (const statement of parsed.statements) {
    const exported = ts.canHaveModifiers(statement)
      && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
    const isDefault = ts.canHaveModifiers(statement)
      && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword) === true

    if (ts.isFunctionDeclaration(statement) && exported) {
      found.push({ name: isDefault ? 'default' : statement.name?.text ?? 'default', kind: isDefault ? 'default' : 'function' })
    } else if (ts.isClassDeclaration(statement) && exported) {
      found.push({ name: isDefault ? 'default' : statement.name?.text ?? 'default', kind: isDefault ? 'default' : 'class' })
    } else if (ts.isVariableStatement(statement) && exported) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) found.push({ name: declaration.name.text, kind: 'const' })
      }
    } else if (ts.isTypeAliasDeclaration(statement) && exported) {
      found.push({ name: statement.name.text, kind: 'type' })
    } else if (ts.isInterfaceDeclaration(statement) && exported) {
      found.push({ name: statement.name.text, kind: 'interface' })
    } else if (ts.isExportAssignment(statement)) {
      found.push({ name: 'default', kind: 'default' })
    } else if (ts.isExportDeclaration(statement)) {
      // `export * from './x'` reexporta tudo, e o nome de cada símbolo não está
      // escrito aqui. Registrar como `re-export` diz a verdade: este arquivo
      // expõe coisas de outro, e quem quer os nomes tem de seguir a aresta.
      if (statement.exportClause === undefined) found.push({ name: '*', kind: 're-export' })
      else if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) found.push({ name: element.name.text, kind: 're-export' })
      }
    }
  }
  return found
}

/** Todos os especificadores que um arquivo importa ou reexporta. */
function collectImports(parsed: ts.SourceFile): readonly string[] {
  const found: string[] = []
  for (const statement of parsed.statements) {
    // `export ... from './x'` também é uma dependência, e esquecê-la deixaria
    // um arquivo de barril parecendo não depender de nada.
    const source = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
      ? statement.moduleSpecifier
      : undefined
    if (source !== undefined && ts.isStringLiteral(source)) found.push(source.text)
  }
  return found
}

/**
 * A qual arquivo do índice um especificador aponta.
 *
 * Só caminhos RELATIVOS resolvem. Um especificador de pacote (`react`) e um
 * apelido de caminho (`@/src/...`) devolvem `null` — não porque não importem,
 * mas porque este índice não tem como saber para onde eles vão sem a
 * configuração do projeto, e chutar produziria uma aresta falsa.
 * @param from - o arquivo que importa.
 * @param specifier - o que está escrito no import.
 * @param known - os arquivos do índice.
 * @returns o arquivo apontado, ou `null`.
 */
export function resolveSpecifier(
  from: string, specifier: string, known: ReadonlySet<string>, aliases: PathAliases = [],
): string | null {
  // O APELIDO vira caminho antes de qualquer coisa (T-15). Sem isto, todo
  // `@/src/components/generated/...` — que e como o template gerado importa
  // quase tudo — devolvia `null`, e o grafo de dependencias ficava com as
  // arestas que menos importam: as relativas dentro da mesma pasta.
  const expanded = expandAlias(specifier, aliases)
  if (expanded === null && !specifier.startsWith('.')) return null
  const base = expanded ?? join(dirname(from), specifier)
  if (base === null) return null
  const candidates = [
    base,
    // A ordem importa: `./x.js` num projeto TypeScript aponta para `x.ts`, e
    // procurar `x.js` primeiro acharia um arquivo compilado se ele existisse
    // ao lado. As duas formas são tentadas, com a fonte na frente.
    ...(base.endsWith('.js') ? [`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`] : []),
    ...(base.endsWith('.jsx') ? [`${base.slice(0, -4)}.tsx`] : []),
    ...READABLE.map(extension => `${base}${extension}`),
    ...READABLE.map(extension => `${base}/index${extension}`),
  ]
  return candidates.find(candidate => known.has(candidate)) ?? null
}

/**
 * Os apelidos de caminho do `tsconfig.json`, ja normalizados.
 *
 * `prefix` sem o `*`, `targets` sem o `*`, na ordem em que o TypeScript os
 * tentaria. A resolucao do TypeScript e mais rica do que isto (ha `baseUrl`,
 * `rootDirs`, `exports` de pacote); o que esta aqui cobre a forma que o
 * template gerado usa, e o que nao casar continua devolvendo `null` em vez de
 * um palpite.
 */
export type PathAliases = readonly { readonly prefix: string; readonly targets: readonly string[] }[]

/**
 * Le os apelidos de caminho do `tsconfig.json` DO APLICATIVO GERADO (T-15).
 *
 * Usa o leitor do proprio TypeScript, e nao `JSON.parse`: um `tsconfig.json`
 * aceita comentario e virgula sobrando, e os dois aparecem em arquivo escrito
 * por gerador. `JSON.parse` lancaria, e um `catch` transformaria "o arquivo tem
 * comentario" em "este projeto nao tem apelido", que e uma conclusao errada
 * sobre um arquivo perfeitamente valido.
 *
 * `baseUrl` entra quando existe: `paths` sao relativos a ele. Ausente, os alvos
 * ja sao relativos a raiz — que e como o template gerado escreve.
 * @param text - o conteudo do `tsconfig.json`.
 * @returns os apelidos, ou uma lista vazia quando nao ha nenhum legivel.
 */
export function parsePathAliases(text: string): PathAliases {
  const parsed = ts.parseConfigFileTextToJson('tsconfig.json', text)
  if (parsed.error !== undefined) return []
  const options: unknown = (parsed.config as { compilerOptions?: unknown } | undefined)?.compilerOptions
  const paths: unknown = (options as { paths?: unknown } | undefined)?.paths
  if (paths === null || typeof paths !== 'object') return []
  const baseUrl = (options as { baseUrl?: unknown } | undefined)?.baseUrl
  const base = typeof baseUrl === 'string' ? normalizeBase(baseUrl) : ''
  const aliases: { prefix: string; targets: string[] }[] = []
  for (const [pattern, value] of Object.entries(paths as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    // So a forma `x/*`. Um apelido EXATO (`@app` -> `src/app.ts`) existe no
    // TypeScript e nao aparece no template gerado; aceita-lo aqui pela metade
    // seria pior do que nao aceitar.
    if (!pattern.endsWith('/*')) continue
    const targets = value
      .filter((entry): entry is string => typeof entry === 'string' && entry.endsWith('/*'))
      // Tira o `*` e MANTEM a barra: o prefixo perde a barra (`@/src`) e o alvo
      // a conserva (`src/`), para que juntar os dois com o resto do caminho
      // produza `src/components/...` e nao `srccomponents/...`.
      .map(entry => `${base}${entry.slice(0, -1).replace(/^\.\//u, '')}`)
    if (targets.length > 0) aliases.push({ prefix: pattern.slice(0, -2), targets })
  }
  // Os mais ESPECIFICOS primeiro: `@/src/*` tem de ser tentado antes de `@/*`,
  // ou todo caminho cairia no apelido mais curto e apontaria para o lugar
  // errado. E o TypeScript resolve assim tambem.
  return aliases.sort((a, b) => b.prefix.length - a.prefix.length)
}

/** A raiz de `baseUrl`, sempre terminada em barra (ou vazia). */
function normalizeBase(baseUrl: string): string {
  const clean = baseUrl.replace(/^\.\//u, '').replace(/\/+$/u, '')
  return clean === '' || clean === '.' ? '' : `${clean}/`
}

/**
 * O primeiro caminho que um apelido produz, ou `null`.
 *
 * Devolve UM alvo — o primeiro — e nao todos. Os demais sao alternativas de
 * fallback do TypeScript, e tentar todas aqui criaria mais de uma aresta para
 * um import que aponta para um arquivo so.
 */
function expandAlias(specifier: string, aliases: PathAliases): string | null {
  for (const alias of aliases) {
    if (!specifier.startsWith(`${alias.prefix}/`)) continue
    const rest = specifier.slice(alias.prefix.length + 1)
    const first = alias.targets[0]
    if (first === undefined) continue
    return `${first}${rest}`
  }
  return null
}

/** O diretório de um caminho, com barras normais. */
function dirname(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? '' : path.slice(0, cut)
}

/**
 * Junta um diretório com um caminho relativo, resolvendo `.` e `..`.
 *
 * Devolve `null` quando o caminho SOBE acima da raiz do aplicativo. Um
 * `../../..` que escapa não é um arquivo do aplicativo, e resolvê-lo para algo
 * dentro dele seria inventar uma dependência que não existe.
 * @param base - o diretório de origem.
 * @param relative - o caminho relativo.
 * @returns o caminho normalizado, ou `null`.
 */
function join(base: string, relative: string): string | null {
  const parts = base === '' ? [] : base.split('/')
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length === 0) return null
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return parts.join('/')
}

/**
 * Quem importa cada arquivo — o grafo lido AO CONTRÁRIO.
 *
 * É esta direção que responde a pergunta cara: "se eu mexer aqui, o que
 * quebra?". A direta ("o que este arquivo usa") qualquer um lê abrindo o
 * arquivo; a inversa exige ler o aplicativo inteiro.
 * @param index - o índice.
 * @returns para cada arquivo, quem depende dele diretamente.
 */
export function dependents(index: CodeIndex): ReadonlyMap<string, readonly string[]> {
  const reverse = new Map<string, string[]>()
  for (const edge of index.imports) {
    if (edge.to === null) continue
    const list = reverse.get(edge.to)
    if (list === undefined) reverse.set(edge.to, [edge.from]); else if (!list.includes(edge.from)) list.push(edge.from)
  }
  for (const [, list] of reverse) list.sort()
  return reverse
}

/**
 * Tudo que pode quebrar se estes arquivos mudarem, DIRETA ou indiretamente.
 *
 * Transitivo de propósito: quem importa quem importa o arquivo alterado também
 * é afetado, e parar no primeiro nível daria uma resposta tranquilizadora e
 * errada.
 *
 * Ciclo NÃO trava e NÃO repete: os visitados são marcados antes de descer. Um
 * aplicativo gerado com barril (`index.ts` que reexporta, e os arquivos que o
 * importam de volta) fecha ciclo com facilidade, e uma travessia ingênua aqui
 * seria uma pilha estourada no meio de um pedido de mudança.
 *
 * O arquivo consultado NÃO aparece no próprio impacto: "o que mais é afetado"
 * é a pergunta, e incluí-lo faria toda resposta ter pelo menos um item.
 * @param index - o índice.
 * @param changed - os arquivos que vão mudar.
 * @returns os afetados, em ordem estável.
 */
export function impactOf(index: CodeIndex, changed: readonly string[]): readonly string[] {
  const reverse = dependents(index)
  const seen = new Set<string>(changed)
  const queue = [...changed]
  const affected = new Set<string>()
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const dependent of reverse.get(current) ?? []) {
      if (seen.has(dependent)) continue
      seen.add(dependent)
      affected.add(dependent)
      queue.push(dependent)
    }
  }
  return [...affected].sort()
}

/**
 * Onde um símbolo já existe.
 *
 * A pergunta que evita o pior desfecho de um pedido de mudança: mandar criar
 * de novo o que já está escrito. Devolve TODOS os arquivos que exportam aquele
 * nome, porque dois arquivos exportando o mesmo nome já é o defeito — e
 * devolver só o primeiro o esconderia.
 * @param index - o índice.
 * @param name - o nome procurado.
 * @returns os arquivos que o exportam, em ordem estável.
 */
export function findSymbol(index: CodeIndex, name: string): readonly string[] {
  const found: string[] = []
  for (const [path, list] of index.symbols) {
    if (list.some(symbol => symbol.name === name)) found.push(path)
  }
  return found.sort()
}

/**
 * Os arquivos que ninguém importa.
 *
 * NÃO é a mesma coisa que "arquivos mortos", e por isso o nome não promete
 * isso: o ponto de entrada do aplicativo não é importado por ninguém e é o
 * arquivo mais vivo que existe. O que esta lista faz é ESTREITAR onde procurar.
 * @param index - o índice.
 * @param entryPoints - os arquivos que são entrada por definição.
 * @returns os não importados, fora as entradas.
 */
export function unimported(index: CodeIndex, entryPoints: readonly string[] = []): readonly string[] {
  const reverse = dependents(index)
  const entries = new Set(entryPoints)
  return index.files
    .filter(path => isReadableSource(path) && !entries.has(path) && (reverse.get(path)?.length ?? 0) === 0)
    .sort()
}

/** Um ciclo de importação, na ordem em que ele fecha. */
export interface ImportCycle { readonly files: readonly string[] }

/**
 * Os ciclos de importação do aplicativo.
 *
 * Ciclo não é sempre defeito — em ESM ele funciona com frequência —, mas ele é
 * a explicação de uma classe inteira de falha que parece inexplicável: um
 * `undefined` na hora de montar a tela, que some ao trocar a ordem de dois
 * imports. Ninguém acha isso lendo arquivo por arquivo.
 * @param index - o índice.
 * @returns os ciclos, um por ciclo, em ordem determinística.
 */
export function importCycles(index: CodeIndex): readonly ImportCycle[] {
  const forward = new Map<string, string[]>()
  for (const edge of index.imports) {
    if (edge.to === null) continue
    const list = forward.get(edge.from)
    if (list === undefined) forward.set(edge.from, [edge.to]); else if (!list.includes(edge.to)) list.push(edge.to)
  }
  const cycles: ImportCycle[] = []
  const vistos = new Set<string>()
  const pilha: string[] = []
  const naPilha = new Set<string>()

  const descer = (node: string): void => {
    vistos.add(node)
    pilha.push(node)
    naPilha.add(node)
    for (const next of (forward.get(node) ?? []).slice().sort()) {
      if (naPilha.has(next)) {
        cycles.push({ files: pilha.slice(pilha.indexOf(next)) })
        continue
      }
      if (!vistos.has(next)) descer(next)
    }
    pilha.pop()
    naPilha.delete(node)
  }

  // A travessia parte dos arquivos em ordem, e marca visitado ANTES de descer.
  // É isso que faz cada ciclo ser relatado uma vez só: a segunda entrada para
  // o mesmo ciclo encontra os nós já visitados e não desce de novo. Uma
  // redução de duplicados depois disto seria código que nenhum caso alcança —
  // e código que nada alcança é código que ninguém pode conferir.
  for (const file of [...index.files].sort()) if (!vistos.has(file) && forward.has(file)) descer(file)
  return cycles
}

/** Diretórios que nunca entram no índice do aplicativo. */
const IGNORED_ROOTS = ['node_modules/', '.next/', '.git/', '.dz23/', 'dist/', 'build/', 'coverage/']

/**
 * Os tetos da leitura, e por que cada um existe.
 *
 * Nenhum deles é performance: os três protegem contra um aplicativo gerado —
 * ou um diretório de execução mexido por fora — que faça a montagem do
 * contexto consumir memória sem fim no meio de um pedido de mudança.
 */
export const APP_SOURCE_LIMITS = {
  /** Quantos arquivos de código o índice lê. */
  files: 400,
  /** Tamanho de UM arquivo. Acima disso ele é pulado, e o pulo é DITO. */
  bytesPerFile: 256 * 1024,
  /** Soma de tudo que foi lido. */
  totalBytes: 4 * 1024 * 1024,
} as const

export interface AppSourcesRead {
  readonly files: readonly SourceFileInput[]
  /**
   * O que ficou de fora, com o motivo.
   *
   * Sai junto com os arquivos, e não num log: um índice construído sobre
   * metade do aplicativo responde "este símbolo não existe" com a mesma
   * confiança que responderia se ele realmente não existisse.
   */
  readonly skipped: readonly { readonly path: string; readonly reason: 'TOO_LARGE' | 'FILE_LIMIT' | 'TOTAL_LIMIT' | 'UNREADABLE' }[]
}

/**
 * Lê os arquivos de código de um diretório de execução.
 *
 * `listTreeFiles` já recusa raiz que seja link simbólico, e é dele que vem a
 * lista. Aqui só se filtra o que é código e se aplicam os tetos.
 * @param runDirectory - a raiz do aplicativo gerado.
 * @param read - como ler um arquivo; injetável para o teste não precisar de disco.
 * @param list - como listar a árvore; injetável pelo mesmo motivo.
 * @returns os arquivos lidos e os que ficaram de fora.
 */
export async function readAppSources(
  runDirectory: string,
  read: (path: string) => Promise<string>,
  list: (root: string) => Promise<readonly string[]>,
): Promise<AppSourcesRead> {
  const all = await list(runDirectory)
  const candidates = all
    .filter(path => isReadableSource(path))
    .filter(path => !IGNORED_ROOTS.some(prefix => path === prefix.slice(0, -1) || path.startsWith(prefix) || path.includes(`/${prefix}`)))
    .sort()

  const files: SourceFileInput[] = []
  const skipped: { path: string; reason: 'TOO_LARGE' | 'FILE_LIMIT' | 'TOTAL_LIMIT' | 'UNREADABLE' }[] = []
  let total = 0
  for (const path of candidates) {
    if (files.length >= APP_SOURCE_LIMITS.files) { skipped.push({ path, reason: 'FILE_LIMIT' }); continue }
    let text: string
    try {
      text = await read(`${runDirectory}/${path}`)
    } catch {
      skipped.push({ path, reason: 'UNREADABLE' })
      continue
    }
    // O teto é sobre BYTES e não sobre caracteres: um arquivo com acento tem
    // mais bytes do que caracteres, e medir o menor dos dois deixaria passar
    // um arquivo maior do que o teto diz.
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > APP_SOURCE_LIMITS.bytesPerFile) { skipped.push({ path, reason: 'TOO_LARGE' }); continue }
    if (total + bytes > APP_SOURCE_LIMITS.totalBytes) {
      // NÃO interrompe: um arquivo pequeno depois de um grande ainda cabe, e
      // parar aqui deixaria de fora por POSIÇÃO o que deveria ficar por
      // tamanho.
      skipped.push({ path, reason: 'TOTAL_LIMIT' })
      continue
    }
    total += bytes
    files.push({ path, text })
  }
  return { files, skipped }
}

/**
 * O que o planejador precisa saber sobre o que JÁ existe, em português.
 *
 * Frase e não JSON: o destinatário é um modelo de linguagem lendo um prompt, e
 * despejar a estrutura inteira gastaria o teto de contexto com pontuação.
 *
 * O que entra, e por quê:
 *
 * - os arquivos que existem, para que o plano não mande criar o que já está lá;
 * - onde cada símbolo exportado mora, que é a resposta a "isso já existe?";
 * - o que QUEBRA se os arquivos alvo mudarem, que é o que ninguém calcula de
 *   cabeça;
 * - o que NÃO pôde ser lido, porque um índice parcial que se apresenta como
 *   completo é pior que índice nenhum.
 * @param index - o índice do aplicativo.
 * @param changed - os arquivos que o pedido de mudança deve tocar, se sabidos.
 * @param skipped - o que a leitura deixou de fora.
 * @returns as linhas do resumo, ou vazio quando não há o que dizer.
 */
export function codeIndexSummary(
  index: CodeIndex,
  changed: readonly string[] = [],
  skipped: AppSourcesRead['skipped'] = [],
): readonly string[] {
  const lines: string[] = []
  const lidos = [...index.symbols.keys()].sort()
  // NÃO há uma saída antecipada para "nada a dizer": cada bloco abaixo já se
  // cala sozinho quando não tem o que dizer, e um `return []` aqui em cima
  // seria uma segunda guarda que nenhum caso alcança. Aplicativo sem código
  // nenhum sai daqui com lista vazia porque todos os blocos ficam calados.
  if (lidos.length > 0) {
    lines.push(t('prompts.codeHeader'))
    for (const path of lidos) {
      const nomes = (index.symbols.get(path) ?? []).map(symbol => symbol.name)
      lines.push(nomes.length === 0
        ? t('prompts.codeNoExports', { path })
        : t('prompts.codeExports', { path, names: nomes.join(', ') }))
    }
  }

  const impacto = changed.length === 0 ? [] : impactOf(index, changed)
  if (impacto.length > 0) {
    lines.push(t('prompts.codeImpact', { files: impacto.join(', ') }))
  }

  const ciclos = importCycles(index)
  if (ciclos.length > 0) {
    lines.push(t('prompts.codeCycles', { cycles: ciclos.map(cycle => cycle.files.join(' -> ')).join('; ') }))
  }

  // A honestidade sobre o que falta vem POR ÚLTIMO e sempre: é a linha que
  // impede o resto de ser lido como um retrato completo.
  const faltando = [...index.unreadable.map(item => item.path), ...skipped.map(item => item.path)].sort()
  if (faltando.length > 0) {
    lines.push(t('prompts.codeIncomplete', { files: faltando.join(', ') }))
  }
  return lines
}

/** O recorte de uma execução de onde o inventário é lido. */
export interface CodeContextRun {
  readonly started_at: string
  readonly run_directory: string
}

/**
 * O inventário do código que já existe, a partir das execuções de um projeto.
 *
 * Está AQUI, e não dentro da montagem do plugin, pela razão que já custou uma
 * guarda morta antes: código que só roda montando o plugin inteiro não é
 * exercido por teste nenhum, e duas falsificações sobreviveram exatamente
 * enquanto isto morava lá.
 *
 * A execução escolhida é a mais RECENTE, e não a mais recente aprovada: um
 * pedido de mudança quase sempre vem depois de uma tentativa que a pessoa não
 * gostou, e é o código dela que está no disco. Escolher a última aprovada
 * mostraria ao planejador um aplicativo que não é o que existe.
 * @param runs - as execuções do projeto.
 * @param read - como ler um arquivo.
 * @param list - como listar a árvore de um diretório.
 * @returns o inventário, ou `undefined` quando não há o que ler.
 */
export async function appCodeContext(
  runs: readonly CodeContextRun[],
  read: (path: string) => Promise<string>,
  list: (root: string) => Promise<readonly string[]>,
): Promise<{ readonly index: CodeIndex; readonly skipped: AppSourcesRead['skipped'] } | undefined> {
  const latest = [...runs].sort((left, right) => left.started_at.localeCompare(right.started_at)).at(-1)
  if (latest === undefined) return undefined
  const sources = await readAppSources(latest.run_directory, read, list).catch(() => undefined)
  // Falha de LEITURA devolve `undefined`, e não um índice vazio: vazio diria ao
  // planejador que o aplicativo não tem código, e ele mandaria criar tudo de
  // novo por cima do que está lá.
  if (sources === undefined) return undefined
  return { index: buildCodeIndex(sources.files), skipped: sources.skipped }
}
