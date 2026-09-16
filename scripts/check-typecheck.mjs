#!/usr/bin/env node
/**
 * Portão de tipos: os DOIS projetos, num comando só.
 *
 * O `tsconfig.json` da raiz cobre `plugins/**` e `scripts/**`, e `apps/studio-web`
 * é um projeto separado com o seu próprio. Conferir um e não o outro deixa
 * metade do repositório sem tipo conferido — e a metade de fora é justamente a
 * que tem a tela e os dublês de e2e.
 *
 * Isto já estava escrito no `CLAUDE.md` como passo manual ("`tsc` na raiz **e**
 * em `apps/studio-web`"), e a regra estava certa. O que falhou foi a execução:
 * numa sessão de nove entregas, o segundo `tsc` foi rodado uma vez, no começo, e
 * a última entrega quebrou o dublê de e2e sem que nada acusasse até o
 * `playwright` não conseguir subir. Um passo manual que dá para pular é um passo
 * que vai ser pulado; um portão não dá.
 *
 * NÃO TEM AUTO-TESTE, e isso é declarado em vez de fingido: o sujeito deste
 * portão é o COMPILADOR, e um auto-teste aqui estaria testando o `tsc`. O modo
 * de falhar que restaria — o portão passar sem olhar nada — é coberto pela
 * cláusula 5.1 da constituição, que recusa veredito cujos contadores são todos
 * zero, e por isso `projetos` sai no veredito.
 *
 * Uso: node scripts/check-typecheck.mjs
 */
import { spawnSync } from 'node:child_process'

const PROJETOS = [
  { nome: 'raiz', comando: 'npx', argumentos: ['tsc', '--noEmit'], cwd: '.' },
  { nome: 'studio-web', comando: 'npx', argumentos: ['tsc', '--noEmit'], cwd: 'apps/studio-web' },
]

let falhas = 0
for (const projeto of PROJETOS) {
  const resultado = spawnSync(projeto.comando, projeto.argumentos, { cwd: projeto.cwd, encoding: 'utf8' })
  if (resultado.status === 0) continue
  falhas += 1
  const saida = `${resultado.stdout ?? ''}${resultado.stderr ?? ''}`.trim()
  // As primeiras linhas bastam: um erro de tipo costuma arrastar dezenas de
  // erros derivados, e despejar todos esconde o primeiro, que é o que importa.
  console.error(`${projeto.nome}:\n${saida.split('\n').slice(0, 12).join('\n')}`)
}
console.log(`TYPECHECK=${falhas === 0 ? 'PASS' : 'FAIL'} projetos=${String(PROJETOS.length)} falhas=${String(falhas)}`)
process.exitCode = falhas === 0 ? 0 : 1
