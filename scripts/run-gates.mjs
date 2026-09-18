#!/usr/bin/env node
/**
 * O AGREGADOR DOS PORTÕES — versionado, e não um arquivo em `/tmp`.
 *
 * ## Por que ele existe
 *
 * A promessa de retomada deste repositório é uma linha só: rodar os portões e a
 * constituição, e olhar o resultado. Durante meses essa linha chamou um
 * `/tmp/gates.sh` criado à mão numa sessão — um arquivo que some quando a
 * máquina reinicia, que não está no histórico e que ninguém pode ler para saber
 * o que ele fazia. Uma revisão externa apontou: a promessa de retomada dependia
 * de um programa que o repositório não tem.
 *
 * ## As duas coisas que ele conserta, e não só a primeira
 *
 * 1. **Ele é versionado e acha a raiz sozinho.** O roteiro temporário começava
 *    com um `cd` para o diretório de UMA máquina — um caminho absoluto de home
 *    que `gate:portability` proíbe em qualquer arquivo executável, e com razão.
 *    Aqui a raiz é deduzida da localização deste arquivo, que está dentro do
 *    repositório por construção.
 * 2. **A lista de portões é DESCOBERTA, e não transcrita.** O roteiro temporário
 *    trazia trinta nomes escritos à mão. `package.json` tinha trinta e um: o
 *    `gate:licenses:release` nunca rodou localmente em sessão nenhuma, e só a CI
 *    o executava. Uma lista copiada é a segunda verdade de sempre — e a que
 *    diverge em silêncio é justamente a que alguém lê para dizer "rodei tudo".
 *
 * Uso:
 *   node scripts/run-gates.mjs                    # todos os portões + a constituição
 *   node scripts/run-gates.mjs --verdicts <arq>   # onde gravar os vereditos
 *   node scripts/run-gates.mjs --apenas a,b,c     # só estes
 *   node scripts/run-gates.mjs --sem-constituicao # pula a conferência final
 *   node scripts/run-gates.mjs --listar           # só diz o que rodaria
 *
 * Sai com 0 quando tudo passa, e com 1 quando qualquer coisa falha.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Os nomes de portão que o `package.json` declara, na ordem em que ele os
 * declara.
 *
 * A ordem do arquivo é a ordem de execução, e isso é deliberado: ela agrupa os
 * portões baratos e estáticos antes dos caros, então uma sessão que interrompe
 * cedo já sabe alguma coisa.
 * @param manifesto - o conteúdo do `package.json`.
 * @returns os nomes sem o prefixo `gate:`.
 */
export function portoesDeclarados(manifesto) {
  return Object.keys(manifesto.scripts ?? {})
    .filter(nome => nome.startsWith('gate:'))
    .map(nome => nome.slice('gate:'.length))
}

/**
 * As linhas de veredito que um portão imprimiu.
 *
 * Todo portão deste repositório termina com uma linha `NOME=PASS` ou
 * `NOME=FAIL`, e é ela que `check-constitution.mjs` lê para saber quem provou o
 * quê. Extrair aqui, e não com `grep`, é o que faz este roteiro funcionar em
 * Windows — onde a CI também roda.
 * @param saida - a saída combinada do portão.
 * @returns as linhas de veredito.
 */
export function vereditosDaSaida(saida) {
  return saida.split(/\r?\n/u).filter(linha => /^[A-Z_]+=(?:PASS|FAIL)$/u.test(linha.split(' ')[0] ?? '') || /^[A-Z_]+=(?:PASS|FAIL)(?:\s|$)/u.test(linha))
}

/**
 * O valor de uma opção de linha de comando.
 * @param argumentos - os argumentos recebidos.
 * @param nome - a opção, com os dois hífens.
 * @returns o valor, ou `null`.
 */
export function opcao(argumentos, nome) {
  const posicao = argumentos.indexOf(nome)
  return posicao >= 0 && posicao + 1 < argumentos.length ? argumentos[posicao + 1] : null
}

const argumentos = process.argv.slice(2)
const manifesto = JSON.parse(readFileSync(join(raiz, 'package.json'), 'utf8'))
const apenas = opcao(argumentos, '--apenas')
const portoes = apenas === null
  ? portoesDeclarados(manifesto)
  : apenas.split(',').map(nome => nome.trim()).filter(nome => nome.length > 0)

if (argumentos.includes('--listar')) {
  process.stdout.write(`${portoes.join('\n')}\nGATES_TOTAL=${portoes.length}\n`)
  process.exit(0)
}

/*
  Os vereditos vão para o temporário do SISTEMA, e não para `/tmp` escrito à mão.

  Eles são saída de execução, não artefato do projeto: gravá-los na árvore faria
  o passo "Refuse unexpected build mutations" da CI reprovar, com razão.
*/
const destino = opcao(argumentos, '--verdicts') ?? join(tmpdir(), 'frigg-verdicts.txt')
const pastaDeLogs = opcao(argumentos, '--logs') ?? join(tmpdir(), 'frigg-gate-logs')
mkdirSync(pastaDeLogs, { recursive: true })
writeFileSync(destino, '')

const executor = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
let falharam = 0

for (const portao of portoes) {
  const execucao = spawnSync(executor, [`gate:${portao}`], { cwd: raiz, encoding: 'utf8' })
  const saida = `${execucao.stdout ?? ''}${execucao.stderr ?? ''}`
  writeFileSync(join(pastaDeLogs, `gate-${portao.replace(/:/gu, '-')}.log`), saida)
  /*
    Um portão que não pôde NASCER não é um portão que passou.

    `spawnSync` devolve `status: null` quando o processo nem começou — pnpm
    ausente, por exemplo. Tratar `null` como sucesso transformaria "não consegui
    medir" em "medi e está certo", que é o erro que este repositório mais
    persegue.
  */
  const passou = execucao.status === 0
  if (!passou) falharam += 1
  process.stdout.write(`${passou ? 'OK  ' : 'FAIL'} ${portao}\n`)
  const vereditos = vereditosDaSaida(saida)
  if (vereditos.length > 0) appendFileSync(destino, `${vereditos.join('\n')}\n`)
}

process.stdout.write(`GATES_FAIL=${falharam === 0 ? 0 : 1} portoes=${portoes.length} vereditos=${destino}\n`)

if (!argumentos.includes('--sem-constituicao')) {
  /*
    A constituição roda AQUI dentro, e não como um segundo comando que se pode
    esquecer.

    Ela é o passo que confere se cada cláusula com portão tem veredito de
    verdade — ou seja, é a única coisa que nota um portão que sumiu da lista. Um
    passo separado que dá para pular foi pulado nove vezes numa sessão só, e foi
    assim que `gate:typecheck` passou a existir.
  */
  const constituicao = spawnSync(process.execPath, ['scripts/check-constitution.mjs', '--verdicts', destino], { cwd: raiz, encoding: 'utf8' })
  process.stdout.write(`${constituicao.stdout ?? ''}${constituicao.stderr ?? ''}`)
  if (constituicao.status !== 0) falharam += 1
}

process.exitCode = falharam === 0 ? 0 : 1
