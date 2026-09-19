import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
  A IMAGEM leva tudo o que o código lê do disco ao carregar.

  Medido em 19/09/2026, na primeira vez que esta imagem rodou de verdade: o
  supervisor morria na partida com ENOENT em `/opt/dz23-preview-supervisor/
  i18n/pt-BR.json`. O Dockerfile copiava só `lib/`, e o catálogo de mensagens
  entrou no código depois — nenhum teste olhava a imagem, porque nenhum a
  construía. Este caso deriva do CÓDIGO as pastas que ele lê por caminho
  relativo e confere que o Dockerfile as copia e o `.dockerignore` as deixa
  passar.
*/
const raiz = resolve(__dirname, '../../..')
const src = resolve(__dirname, '../src')

function pastasLidas(): string[] {
  const pastas = new Set<string>()
  for (const arquivo of readdirSync(src).filter(nome => nome.endsWith('.ts'))) {
    for (const achado of readFileSync(resolve(src, arquivo), 'utf8').matchAll(/new URL\('\.\.\/([a-z0-9-]+)\//gu)) pastas.add(achado[1]!)
  }
  return [...pastas].sort()
}

describe('a imagem do supervisor de prévias', () => {
  const dockerfile = readFileSync(resolve(raiz, 'deploy/preview-supervisor/Dockerfile'), 'utf8')
  const ignorar = readFileSync(resolve(raiz, 'deploy/preview-supervisor/Dockerfile.dockerignore'), 'utf8').split('\n')

  it('o código lê o catálogo de mensagens do disco (senão este teste não protege nada)', () => {
    expect(pastasLidas()).toContain('i18n')
  })

  it.each(pastasLidas())('copia %s e o .dockerignore deixa passar', pasta => {
    expect(dockerfile).toMatch(new RegExp(`^COPY .*plugins/preview-supervisor/${pasta} \\./${pasta}$`, 'mu'))
    expect(ignorar).toContain(`!plugins/preview-supervisor/${pasta}/**`)
  })
})
