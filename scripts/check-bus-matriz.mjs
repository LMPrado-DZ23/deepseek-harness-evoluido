#!/usr/bin/env node
/**
 * O PORTÃO DA MATRIZ CANÔNICA: obrigação não fecha por coincidência de número.
 *
 * O defeito que ele impede de voltar é real e já aconteceu. Três fatias do Modo
 * Empresa saíram rotuladas `BUS-01`, `BUS-02` e `BUS-03`. Na matriz canônica,
 * `BUS-02` é pesquisa de mercado e `BUS-03` é oferta, catálogo e preço — e o
 * que foi entregue com esses números foi "criar tarefa a partir da empresa" e
 * "ver os pacotes que a tarefa produziu".
 *
 * Ninguém mentiu. É pior que isso: quem lesse o livro mestre e a matriz lado a
 * lado concluiria que duas obrigações fecharam, e as duas continuam sem uma
 * linha de código. Nenhum teste podia pegar — os testes provam o que a fatia
 * FAZ, e o rótulo não é comportamento.
 *
 * ## As três regras
 *
 * 1. **A matriz é a autoridade.** Os 24 identificadores e as capacidades que
 *    eles nomeiam não são renumerados, reescritos nem reordenados para caber na
 *    ordem em que o trabalho aconteceu.
 * 2. **O livro mestre usa identificadores LOCAIS.** Um `BUS-NN` na coluna de
 *    identificador do livro significaria que a obrigação canônica INTEIRA
 *    fechou — e nenhuma fechou.
 * 3. **A ponte é declarada**, em `docs/status/BUS_CORRESPONDENCIA.md`, e ela
 *    diz por significado o que cada entrega toca e o que continua faltando.
 *
 * Uso: node scripts/check-bus-matriz.mjs [--self-test]
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const raiz = process.cwd()
const MATRIZ = 'audit/V6_CONFERENCIA_2026-09-16/MATRIZ_RECONCILIADA_COERENTE.json'
const PONTE = 'docs/status/BUS_CORRESPONDENCIA.md'
const LIVRO = 'docs/MASTER_REQUIREMENTS_LEDGER.md'

/**
 * As obrigações canônicas, lidas da matriz preservada.
 *
 * A leitura é RECURSIVA porque a matriz é um documento de auditoria e a forma
 * dela não é contrato: procurar por caminho fixo faria o portão parar de olhar
 * no dia em que alguém aninhasse a lista em outro lugar — e parar de olhar em
 * silêncio é o defeito que este portão existe para impedir.
 * @param no - o nó corrente.
 * @param achados - o acumulador.
 * @returns id → capacidade.
 */
export function obrigacoes(no, achados = new Map()) {
  if (Array.isArray(no)) {
    for (const item of no) obrigacoes(item, achados)
  } else if (no !== null && typeof no === 'object') {
    const id = no.id
    if (typeof id === 'string' && /^BUS-\d{2}$/u.test(id) && typeof no.capacidade === 'string' && !achados.has(id)) {
      achados.set(id, no.capacidade)
    }
    for (const valor of Object.values(no)) obrigacoes(valor, achados)
  }
  return achados
}

/**
 * Os identificadores que a coluna de IDENTIFICADOR do livro mestre usa.
 *
 * Só a PRIMEIRA célula de cada linha de tabela: um `BUS-04` citado no meio de
 * um texto é referência, e referenciar a matriz é exatamente o que se quer.
 * @param texto - o livro mestre.
 * @returns os identificadores, na ordem.
 */
export function identificadoresDoLivro(texto) {
  const linhas = texto.split('\n').filter(linha => linha.startsWith('| '))
  return linhas
    .map(linha => linha.slice(2, linha.indexOf(' |', 2)).trim())
    .filter(celula => celula !== '' && !celula.startsWith('---') && celula !== 'requisito' && celula !== 'estado' && celula !== 'versao-alvo')
}

/**
 * As linhas da ponte, uma por entrega.
 * @param texto - o documento da ponte.
 * @returns as linhas com entrega, obrigação tocada e estado.
 */
export function linhasDaPonte(texto) {
  return texto.split('\n')
    .filter(linha => /^\| `EMP-/u.test(linha))
    .map(linha => linha.split('|').map(celula => celula.trim()))
    .map(celulas => ({ entrega: celulas[1], toca: celulas[4], estado: celulas[5], falta: celulas[6] ?? '' }))
}

/**
 * Os achados, dadas as três leituras.
 *
 * Extraída por uma razão que este repositório aprendeu mais de dez vezes: a
 * decisão que mora no corpo do roteiro não é exercitada por teste nenhum.
 * @param matriz - id → capacidade.
 * @param ponte - as linhas da ponte.
 * @param idsDoLivro - a coluna de identificador do livro mestre.
 * @returns os achados.
 */
/**
 * As obrigações que a CONCLUSÃO do documento chama de ausentes, contra o que a
 * TABELA do mesmo documento diz.
 *
 * ## Por que isto existe
 *
 * Porque aconteceu. Até `a04b0d6`, a tabela registrava `EMP-04` tocando
 * `BUS-03` com estado PARCIAL, e o parágrafo de fecho, doze linhas abaixo,
 * afirmava que `BUS-03` estava AUSENTE com zero linha de código. Os dois no
 * mesmo arquivo. Uma revisão externa achou; nenhum portão achava, porque este
 * conferia a tabela e ninguém conferia a prosa contra ela.
 *
 * A regra é uma só, e é a que o caso pedia: uma obrigação que a tabela declara
 * tocada não pode ser chamada de AUSENTE pela conclusão. O contrário —
 * conclusão dizendo PARCIAL sobre algo que a tabela não toca — não é conferido
 * aqui, porque uma obrigação pode estar parcial por trabalho que não veio do
 * Modo Empresa, e cobrar isso obrigaria a inventar linha de tabela.
 *
 * ## O que ele NÃO faz
 *
 * Não lê o resto da prosa. Este não é um portão de texto: é uma conferência de
 * UMA afirmação, a que já se contradisse. Transformar isto numa infraestrutura
 * de gates de prosa para consertar um parágrafo seria trocar um defeito por um
 * peso permanente, e a própria revisão pediu para não fazer isso.
 * @param texto - o documento da ponte.
 * @param linhas - as linhas da tabela.
 * @returns as reprovações.
 */
export function contradicoesDaConclusao(texto, linhas) {
  const tocadas = new Map()
  for (const linha of linhas) {
    const id = linha.toca.replaceAll('`', '').trim()
    if (/^BUS-\d+$/u.test(id)) tocadas.set(id, linha)
  }
  const conclusao = /##\s*O que isto NÃO muda\n([\s\S]*?)(?:\n##\s|$)/u.exec(texto)?.[1] ?? ''
  const lista = []
  /*
    A citação HISTÓRICA é reconhecida, e não proibida: o documento precisa poder
    dizer "até tal instantâneo, isto aqui afirmava outra coisa". O que a
    distingue é estar dentro de uma citação em bloco (`>`), que é como este
    repositório marca passado.
  */
  const atual = conclusao.split('\n').filter(linha => !linha.trimStart().startsWith('>')).join('\n')
  for (const [id, linha] of tocadas) {
    const afirmaAusente = new RegExp(`\`${id}\`[^.\n]*\\*\\*AUSENTE`, 'u').test(atual)
      || new RegExp(`\`${id}\`[^.\n]*(?:e|,)[^.\n]*\`BUS-\\d+\`[^.\n]*\\*\\*AUSENTE`, 'u').test(atual)
    if (afirmaAusente) {
      lista.push({ onde: PONTE, motivo: `a conclusão chama ${id} de AUSENTE e a tabela registra ${linha.entrega} tocando-a com estado ${linha.estado}` })
    }
  }
  return lista
}

export function achados(matriz, ponte, idsDoLivro) {
  const lista = []
  const reprove = (onde, motivo) => lista.push({ onde, motivo })

  if (matriz.size === 0) reprove(MATRIZ, 'nenhuma obrigação canônica foi encontrada — a matriz é a autoridade e ficou ilegível')

  for (const id of idsDoLivro) {
    if (/^BUS-\d{2}/u.test(id)) {
      reprove(LIVRO, `a linha \`${id}\` usa um identificador da matriz como identificador de ENTREGA; use um identificador local e declare a correspondência em ${PONTE}`)
    }
  }

  if (ponte.length === 0) reprove(PONTE, 'nenhuma linha de correspondência — a ponte vazia deixa a colisão de rótulo sem registro')

  for (const linha of ponte) {
    if (linha.toca !== 'nenhuma' && !/^`BUS-\d{2}`$/u.test(linha.toca)) {
      reprove(PONTE, `${linha.entrega} diz tocar ${JSON.stringify(linha.toca)}, que não tem a forma de uma obrigação canônica`)
      continue
    }
    if (linha.toca === 'nenhuma') continue
    const id = linha.toca.replaceAll('`', '')
    if (!matriz.has(id)) reprove(PONTE, `${linha.entrega} diz tocar ${id}, que não existe na matriz`)
    // FECHA é a afirmação forte, e ela precisa dizer que nada falta. Uma linha
    // que fecha e ao mesmo tempo lista o que falta é a contradição que este
    // portão existe para não deixar passar em silêncio.
    if (linha.estado === 'FECHA' && linha.falta !== '—' && linha.falta !== '') {
      reprove(PONTE, `${linha.entrega} declara FECHA sobre ${id} e ainda lista o que falta`)
    }
    if (linha.estado === 'PARCIAL' && (linha.falta === '' || linha.falta === '—')) {
      reprove(PONTE, `${linha.entrega} declara PARCIAL sobre ${id} sem dizer o que falta — PARCIAL sem resto é FECHA disfarçado`)
    }
  }
  return lista
}

if (process.argv.includes('--self-test')) {
  let casos = 0
  const check = (condicao, mensagem) => { casos += 1; if (!condicao) { process.stdout.write(`BUS_MATRIZ_SELF_TEST=FAIL ${mensagem}\n`); process.exit(1) } }
  const matrizFake = new Map([['BUS-01', 'x'], ['BUS-22', 'y']])
  check(obrigacoes({ a: [{ id: 'BUS-01', capacidade: 'x' }] }).get('BUS-01') === 'x', 'nao achou obrigacao aninhada')
  check(obrigacoes({ id: 'BUS-1', capacidade: 'x' }).size === 0, 'aceitou id fora do formato')
  check(identificadoresDoLivro('| EMP-01 | a | b |').length === 1, 'nao leu a coluna de identificador')
  check(achados(matrizFake, [{ entrega: '`EMP-01`', toca: '`BUS-01`', estado: 'PARCIAL', falta: 'z' }], ['BUS-01']).length === 1, 'nao pegou BUS-NN como identificador de entrega')
  check(achados(matrizFake, [{ entrega: '`EMP-01`', toca: '`BUS-99`', estado: 'PARCIAL', falta: 'z' }], ['EMP-01']).length === 1, 'aceitou obrigacao inexistente')
  check(achados(matrizFake, [{ entrega: '`EMP-01`', toca: '`BUS-01`', estado: 'FECHA', falta: 'z' }], ['EMP-01']).length === 1, 'aceitou FECHA com resto')
  check(achados(matrizFake, [{ entrega: '`EMP-01`', toca: '`BUS-01`', estado: 'PARCIAL', falta: '—' }], ['EMP-01']).length === 1, 'aceitou PARCIAL sem resto')
  check(achados(matrizFake, [{ entrega: '`EMP-01`', toca: '`BUS-01`', estado: 'PARCIAL', falta: 'z' }], ['EMP-01']).length === 0, 'reprovou linha correta')
  check(achados(new Map(), [], []).length === 2, 'matriz vazia e ponte vazia nao reprovaram')
  // A CONTRADICAO que a revisao de 18/09/2026 achou: tabela toca, conclusao chama de ausente.
  const tocaBus03 = [{ entrega: '`EMP-04`', toca: '`BUS-03`', estado: 'PARCIAL', falta: 'vitrine' }]
  check(contradicoesDaConclusao('## O que isto NÃO muda\n\n`BUS-03` continua **AUSENTE**, com zero linha.\n', tocaBus03).length === 1,
    'aceitou a conclusao chamando de AUSENTE o que a tabela toca')
  check(contradicoesDaConclusao('## O que isto NÃO muda\n\n`BUS-02` e `BUS-03` continuam **AUSENTES**.\n', tocaBus03).length === 1,
    'aceitou a forma com dois identificadores numa frase so')
  check(contradicoesDaConclusao('## O que isto NÃO muda\n\n`BUS-03` está **PARCIAL** desde EMP-04.\n', tocaBus03).length === 0,
    'reprovou uma conclusao que concorda com a tabela')
  // O passado fica: dentro de citacao em bloco, a frase antiga nao e afirmacao atual.
  check(contradicoesDaConclusao('## O que isto NÃO muda\n\n`BUS-03` está **PARCIAL**.\n\n> Até a04b0d6 isto dizia que `BUS-03` estava **AUSENTE**.\n', tocaBus03).length === 0,
    'reprovou a citacao historica em bloco')
  process.stdout.write(`BUS_MATRIZ_SELF_TEST=PASS casos=${casos}\n`)
  process.exit(0)
}

const textoDaPonte = readFileSync(resolve(raiz, PONTE), 'utf8')
const matriz = obrigacoes(JSON.parse(readFileSync(resolve(raiz, MATRIZ), 'utf8')))
const ponte = linhasDaPonte(textoDaPonte)
const idsDoLivro = identificadoresDoLivro(readFileSync(resolve(raiz, LIVRO), 'utf8'))
const lista = [...achados(matriz, ponte, idsDoLivro), ...contradicoesDaConclusao(textoDaPonte, ponte)]
for (const { onde, motivo } of lista) process.stdout.write(`  ${onde}: ${motivo}\n`)
process.stdout.write(`BUS_MATRIZ=${lista.length === 0 ? 'PASS' : 'FAIL'} obrigacoes=${matriz.size} correspondencias=${ponte.length} entregas_no_livro=${idsDoLivro.length} achados=${lista.length}\n`)
process.exitCode = lista.length === 0 ? 0 : 1
