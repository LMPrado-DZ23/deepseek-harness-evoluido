import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SONDA_PADRAO, docker, observar } from './studio-start.mjs'
import { bloqueios, conferencias } from './studio-doctor.mjs'

/**
 * O que `pnpm studio` vê do disco.
 *
 * `observar` parece montagem, e não é: ela decide QUAL arquivo conta como prova
 * de cada pré-requisito. Se ela olhar para o lugar errado, o doctor responde com
 * confiança total a pergunta errada — e a pessoa vai consertar algo que já
 * estava certo. Por isso cada caminho é conferido contra uma pasta de verdade.
 */

let base
/*
  A SONDA do Docker, que responde na hora.

  Sem ela, cada chamada a `observar` paga um `docker info` — até dez segundos de
  espera por um daemon externo, dentro de um teste que tem cinco. A CI reprovou
  por isso em 18/09/2026, neste arquivo, num caso que só olha caminhos no disco.

  O que estes testes medem é QUAL arquivo conta como prova de cada pré-requisito.
  Se o Docker atende ou não é outra pergunta, e ela não pertence aqui.
*/
const sondaParada = { docker: () => false }
const criar = caminho => {
  const alvo = resolve(base, caminho)
  mkdirSync(dirname(alvo), { recursive: true })
  writeFileSync(alvo, '{}')
}

beforeEach(() => { base = mkdtempSync(resolve(tmpdir(), 'dz23-studio-')) })
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

describe('a sonda padrão', () => {
  it('a PRODUÇÃO pergunta ao Docker de verdade', () => {
    /*
      Este caso parece trivial e não é: ele é o único lugar que afirma qual sonda
      o produto usa quando ninguém passa uma. Todos os outros casos deste arquivo
      injetam a sonda parada — e é isso que os deixa rápidos —, então trocar o
      padrão por `() => true` passaria por todos eles. Uma sabotagem fez
      exatamente isso e sobreviveu.

      LIMITE DECLARADO: isto prova a LIGAÇÃO, e não o comportamento da sonda.
      Que `docker()` responda certo a um daemon parado não é conferido aqui —
      seria pagar de novo o custo externo que este arquivo acabou de tirar.
    */
    expect(SONDA_PADRAO.docker).toBe(docker)
  })
})

describe('observar — a pasta vazia', () => {
  it('não afirma que nada existe: afirma que não encontrou', () => {
    const visto = observar(base, process, sondaParada)
    expect(visto.submoduloPresente).toBe(false)
    expect(visto.harnessInstalado).toBe(false)
    expect(visto.harnessCompilado).toBe(false)
    expect(visto.studioInstalado).toBe(false)
    expect(visto.studioCompilado).toBe(false)
    expect(visto.perfilPresente).toBe(false)
  })

  it('a versão do Node vem do processo, e a esperada do .nvmrc da pasta', () => {
    expect(observar(base, process, sondaParada).nodeVersion).toBe(process.versions.node)
    // Sem `.nvmrc` na pasta de teste, não há contra o que comparar.
    expect(observar(base, process, sondaParada).nodeEsperado).toBeUndefined()
    writeFileSync(resolve(base, '.nvmrc'), 'v22.23.1\n')
    expect(observar(base, process, sondaParada).nodeEsperado).toBe('22.23.1')
  })

  it('as rotas vêm do AMBIENTE, e uma lista vazia é uma resposta', () => {
    // Perguntar ao Studio quais rotas ele tem exigiria que ele já estivesse no
    // ar — e esta conferência existe exatamente para o caso em que ele não
    // está. O ambiente responde sem abrir conexão nenhuma.
    expect(observar(base, { versions: process.versions, env: {} }, sondaParada).rotasConfiguradas).toEqual([])
    expect(observar(base, { versions: process.versions, env: { DZ23_OMNIROUTE_KEY: "k" } }, sondaParada).rotasConfiguradas).toEqual(['omniroute'])
  })
})

describe('observar — cada pré-requisito tem o SEU arquivo', () => {
  it('o submódulo é o package.json do Harness, e não a pasta vazia que o git deixa', () => {
    // `git clone` sem `--recursive` deixa a pasta CRIADA e vazia. Conferir a
    // existência da pasta responderia "está no lugar" para o caso exato que
    // esta conferência existe para pegar.
    mkdirSync(resolve(base, 'third_party', 'deepseek-harness'), { recursive: true })
    expect(observar(base, process, sondaParada).submoduloPresente).toBe(false)
    criar('third_party/deepseek-harness/package.json')
    expect(observar(base, process, sondaParada).submoduloPresente).toBe(true)
  })

  it('o Harness compilado é um pacote com lib, e não o node_modules dele', () => {
    criar('third_party/deepseek-harness/node_modules/marca')
    expect(observar(base, process, sondaParada).harnessInstalado).toBe(true)
    // Instalado e compilado são duas coisas, e o comando que resolve cada uma é
    // diferente.
    expect(observar(base, process, sondaParada).harnessCompilado).toBe(false)
    // O checkout do submódulo já traz a PASTA de cada pacote. Conferir a pasta
    // responderia "compilado" para um Harness que nunca foi construído — que é
    // o estado em que a pessoa está logo depois de baixar o repositório.
    criar('third_party/deepseek-harness/packages/core/agent-default-model/package.json')
    expect(observar(base, process, sondaParada).harnessCompilado).toBe(false)
    criar('third_party/deepseek-harness/packages/core/agent-default-model/lib/index.js')
    expect(observar(base, process, sondaParada).harnessCompilado).toBe(true)
  })

  it('o Studio instalado é o escopo @dz23-studio dentro de node_modules', () => {
    criar('node_modules/outra-coisa/package.json')
    expect(observar(base, process, sondaParada).studioInstalado).toBe(false)
    criar('node_modules/@dz23-studio/prompt-to-app/package.json')
    expect(observar(base, process, sondaParada).studioInstalado).toBe(true)
  })

  it('o Studio compilado é a lib de um plugin, e não o código-fonte dele', () => {
    criar('plugins/prompt-to-app/src/index.ts')
    expect(observar(base, process, sondaParada).studioCompilado).toBe(false)
    criar('plugins/prompt-to-app/lib/index.js')
    expect(observar(base, process, sondaParada).studioCompilado).toBe(true)
  })

  it('o perfil é o package.json do perfil studio, e não a pasta dsh-home', () => {
    mkdirSync(resolve(base, 'dsh-home', 'profiles', 'studio'), { recursive: true })
    expect(observar(base, process, sondaParada).perfilPresente).toBe(false)
    criar('dsh-home/profiles/studio/package.json')
    expect(observar(base, process, sondaParada).perfilPresente).toBe(true)
  })
})

describe('observar + conferencias — o clone recém-baixado', () => {
  it('manda fazer UMA coisa: iniciar o submódulo', () => {
    // Este é o estado exato em que alguém abre o produto pela primeira vez.
    writeFileSync(resolve(base, '.nvmrc'), `${process.versions.node}\n`)
    const lista = conferencias(observar(base, process, sondaParada))
    expect(bloqueios(lista)[0].id).toBe('submodulo')
    expect(bloqueios(lista)[0].faca).toContain('git submodule update --init')
  })
})

describe('o comando existe de verdade', () => {
  it('`pnpm studio` e `pnpm studio:doctor` estão no package.json e apontam para este arquivo', async () => {
    // O buraco que este bloco fecha era exatamente este: quarenta scripts
    // `prove:*` e nenhum que iniciasse o produto.
    const pacote = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(new URL('../package.json', import.meta.url), 'utf8')))
    expect(pacote.scripts.studio).toBe('node scripts/studio-start.mjs')
    expect(pacote.scripts['studio:doctor']).toBe('node scripts/studio-start.mjs --conferir')
  })
})
