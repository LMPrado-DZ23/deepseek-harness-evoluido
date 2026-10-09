import { lstat, readdir, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Deixa o store do `pnpm fetch` no formato que o construtor aceita.
 *
 * ## O que o pnpm 11 deixa ali, e por que sai
 *
 * Medido em 19/09/2026 no primeiro `setup-templates` numa máquina real: o
 * `pnpm fetch` do pnpm 11 grava em `v11/projects/` um REGISTRO dos projetos que
 * usaram o store — um link simbólico por projeto, apontando para o espaço
 * temporário do fetch (`/tmp/dz23-template-fetch-*`). O espaço é apagado logo
 * depois, e os links ficam PENDURADOS. O provisionamento do construtor recusa
 * link simbólico no store (com razão: um link é um caminho para fora dele), e
 * por isso recusava o único store que este script sabe produzir.
 *
 * O registro só serve ao `pnpm store prune`, que o construtor nunca roda; a
 * instalação offline lê `files/` e `index.db`. Por isso ele sai — e SÓ ele.
 *
 * ## O que NÃO sai
 *
 * Nada fora de `v<N>/projects/`, e nada ali dentro que não seja link
 * simbólico. Um arquivo ou pasta de verdade nesse lugar não é o que o pnpm
 * grava, e apagá-lo seria apagar algo que ninguém mediu: a função recusa.
 * @param store - a raiz do store (`runtime/template-store-v2`).
 * @returns quantos links do registro foram tirados.
 */
export async function normalizarStoreDoPnpm(store) {
  let removidos = 0
  for (const versao of await readdir(store)) {
    if (!/^v\d+$/u.test(versao)) continue
    const projetos = join(store, versao, 'projects')
    const estado = await lstat(projetos).catch(() => undefined)
    if (estado === undefined) continue
    if (!estado.isDirectory() || estado.isSymbolicLink()) throw new Error(`registro de projetos inesperado: ${projetos}`)
    const nomes = await readdir(projetos)
    for (const nome of nomes) {
      const alvo = join(projetos, nome)
      if (!(await lstat(alvo)).isSymbolicLink()) throw new Error(`entrada que não é link no registro de projetos: ${alvo}`)
    }
    for (const nome of nomes) { await rm(join(projetos, nome)); removidos += 1 }
    // `rmdir`, e não `rm` recursivo: a pasta já tem de estar vazia aqui.
    await rmdir(projetos)
  }
  return removidos
}
