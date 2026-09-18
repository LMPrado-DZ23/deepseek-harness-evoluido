#!/usr/bin/env node
/**
 * O PORTÃO DO REF COMPOSTO (REV-CAN-B).
 *
 * Ele existe por um defeito REAL, achado por revisão externa lendo o código e
 * reproduzido em navegador antes do conserto: o quadro da prévia trazia
 * `ref={refDoQuadro ?? quadro}`.
 *
 * Lido rápido, aquilo parece "use o de fora quando houver". O que ele faz é
 * "DESLIGUE o de dentro quando houver" — e o produto montado sempre passa o de
 * fora, então o de dentro nunca era preenchido no único lugar onde importa. O
 * efeito era invisível: o quadro desenhava, a conferência de mensagem passava a
 * comparar contra `undefined` e recusava TODAS as mensagens, inclusive as
 * legítimas, e o modo de seleção era enviado para um quadro que o componente não
 * tinha. Nenhum teste desta missão pegava, porque todos exercitavam a FUNÇÃO e o
 * defeito estava na MONTAGEM — a lição mais repetida deste repositório.
 *
 * `ref` não é um valor que se escolhe: é um SUMIDOURO de efeito, e dois
 * sumidouros precisam dos DOIS. Quem precisa dos dois usa `refComposto`.
 *
 * A varredura de 18/09 não achou outra ocorrência no repositório. Um portão
 * sobre zero achados não é enfeite: sem ele, o padrão volta no próximo
 * componente que aceitar um `ref` de fora, e volta calado.
 *
 * Uso: node scripts/check-refs.mjs [--self-test]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const RAIZ = process.cwd()
const PASTAS = ['apps', 'plugins']
const IGNORADAS = new Set(['node_modules', 'lib', 'dist', 'coverage', '.git'])

/**
 * Os `ref` de JSX que escolhem UM entre dois destinos.
 *
 * A leitura é por expressão regular de propósito: o portão roda em Node puro,
 * sobre TypeScript não compilado, e um analisador completo aqui seria uma
 * segunda descrição do compilador apodrecendo em ritmo próprio. O preço é
 * declarado: ele vê `ref={...}` numa linha só, e um `ref` quebrado em várias
 * linhas escapa. É o formato que este repositório escreve.
 * @param fonte - o conteúdo do arquivo.
 * @returns as linhas com o defeito, com o trecho.
 */
export function refsQueEscolhem(fonte) {
  const saida = []
  const linhas = fonte.split('\n')
  for (const [indice, linha] of linhas.entries()) {
    // Comentário não é montagem: este portão nasceu junto de comentários que
    // CITAM o defeito para explicá-lo, e recusá-los proibiria documentá-lo.
    const semSpaco = linha.trimStart()
    if (semSpaco.startsWith('*') || semSpaco.startsWith('//')) continue
    const achado = /\bref=\{([^}]*)\}/u.exec(linha)
    if (achado === null) continue
    const dentro = achado[1]
    if (!/\?\?|\|\|/u.test(dentro)) continue
    // CITAÇÃO entre crases não é montagem. Este portão nasceu junto de testes e
    // comentários que escrevem o defeito por extenso para explicá-lo, e recusar
    // isso proibiria descrevê-lo — que é justamente como ele volta calado. Uma
    // crase de cada lado não acontece em JSX de verdade: ali o trecho estaria
    // dentro de um texto, e não montando elemento nenhum.
    const inicio = achado.index
    const fim = inicio + achado[0].length
    if (linha[inicio - 1] === '`' && linha[fim] === '`') continue
    saida.push({ linha: indice + 1, trecho: achado[0] })
  }
  return saida
}

function arquivos(pasta) {
  const saida = []
  for (const entrada of readdirSync(pasta)) {
    if (IGNORADAS.has(entrada)) continue
    const caminho = join(pasta, entrada)
    if (statSync(caminho).isDirectory()) { saida.push(...arquivos(caminho)); continue }
    if (/\.tsx?$/u.test(entrada)) saida.push(caminho)
  }
  return saida
}

function selfTest() {
  const casos = [
    ['o defeito real e pego', 'ref={refDoQuadro ?? quadro}', 1],
    ['a variante com || e pega', '  <div ref={deFora || interno} />', 1],
    ['o ref composto passa', 'ref={refComposto(quadro, refDoQuadro)}', 0],
    ['o ref simples passa', '<div ref={caixa}>', 0],
    ['outro atributo com ?? passa', 'src={externo ?? interno}', 0],
    ['comentario que CITA o defeito passa', ' * O quadro tinha `ref={a ?? b}`, e isso desliga o de dentro', 0],
    ['linha de comentario // tambem passa', '// ref={a ?? b} era o defeito', 0],
    ['citacao entre crases passa', '    codigo: `ref={refDoQuadro ?? quadro}` desliga o de dentro', 0],
    ['crase de um lado so NAO passa', '  <div ref={a ?? b}` />', 1],
  ]
  let falhas = 0
  for (const [nome, fonte, esperado] of casos) {
    const achou = refsQueEscolhem(fonte).length
    if (achou !== esperado) { falhas += 1; console.error(`  autoteste FALHOU: ${nome} (esperado ${esperado}, achou ${achou})`) }
  }
  console.log(`REFS_SELF_TEST=${falhas === 0 ? 'PASS' : 'FAIL'} casos=${casos.length}`)
  return falhas === 0
}

if (process.argv.includes('--self-test')) {
  process.exit(selfTest() ? 0 : 1)
}

const achados = []
let lidos = 0
for (const pasta of PASTAS) {
  for (const caminho of arquivos(resolve(RAIZ, pasta))) {
    lidos += 1
    for (const achado of refsQueEscolhem(readFileSync(caminho, 'utf8'))) {
      achados.push(`${relative(RAIZ, caminho)}:${achado.linha}: ${achado.trecho} — \`ref\` é sumidouro de efeito, e escolher UM desliga o outro; use \`refComposto\``)
    }
  }
}
for (const achado of achados) console.error(achado)
console.log(`REFS=${achados.length === 0 ? 'PASS' : 'FAIL'} arquivos=${lidos} achados=${achados.length}`)
process.exit(achados.length === 0 ? 0 : 1)
