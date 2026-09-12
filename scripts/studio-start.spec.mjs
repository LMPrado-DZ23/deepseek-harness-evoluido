import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { observar } from './studio-start.mjs'
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
const criar = caminho => {
  const alvo = resolve(base, caminho)
  mkdirSync(dirname(alvo), { recursive: true })
  writeFileSync(alvo, '{}')
}

beforeEach(() => { base = mkdtempSync(resolve(tmpdir(), 'dz23-studio-')) })
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

describe('observar — a pasta vazia', () => {
  it('não afirma que nada existe: afirma que não encontrou', () => {
    const visto = observar(base)
    expect(visto.submoduloPresente).toBe(false)
    expect(visto.harnessInstalado).toBe(false)
    expect(visto.harnessCompilado).toBe(false)
    expect(visto.studioInstalado).toBe(false)
    expect(visto.studioCompilado).toBe(false)
    expect(visto.perfilPresente).toBe(false)
  })

  it('a versão do Node vem do processo, e a esperada do .nvmrc da pasta', () => {
    expect(observar(base).nodeVersion).toBe(process.versions.node)
    // Sem `.nvmrc` na pasta de teste, não há contra o que comparar.
    expect(observar(base).nodeEsperado).toBeUndefined()
    writeFileSync(resolve(base, '.nvmrc'), 'v22.23.1\n')
    expect(observar(base).nodeEsperado).toBe('22.23.1')
  })

  it('o que NÃO foi perguntado sai indefinido, e nunca como zero', () => {
    // `rotasConfiguradas` só é sabido depois que o Studio sobe. Zero aqui diria
    // "nenhuma configurada" sobre algo que ninguém olhou.
    expect(observar(base).rotasConfiguradas).toBeUndefined()
  })
})

describe('observar — cada pré-requisito tem o SEU arquivo', () => {
  it('o submódulo é o package.json do Harness, e não a pasta vazia que o git deixa', () => {
    // `git clone` sem `--recursive` deixa a pasta CRIADA e vazia. Conferir a
    // existência da pasta responderia "está no lugar" para o caso exato que
    // esta conferência existe para pegar.
    mkdirSync(resolve(base, 'third_party', 'deepseek-harness'), { recursive: true })
    expect(observar(base).submoduloPresente).toBe(false)
    criar('third_party/deepseek-harness/package.json')
    expect(observar(base).submoduloPresente).toBe(true)
  })

  it('o Harness compilado é um pacote com lib, e não o node_modules dele', () => {
    criar('third_party/deepseek-harness/node_modules/marca')
    expect(observar(base).harnessInstalado).toBe(true)
    // Instalado e compilado são duas coisas, e o comando que resolve cada uma é
    // diferente.
    expect(observar(base).harnessCompilado).toBe(false)
    // O checkout do submódulo já traz a PASTA de cada pacote. Conferir a pasta
    // responderia "compilado" para um Harness que nunca foi construído — que é
    // o estado em que a pessoa está logo depois de baixar o repositório.
    criar('third_party/deepseek-harness/packages/core/agent-default-model/package.json')
    expect(observar(base).harnessCompilado).toBe(false)
    criar('third_party/deepseek-harness/packages/core/agent-default-model/lib/index.js')
    expect(observar(base).harnessCompilado).toBe(true)
  })

  it('o Studio instalado é o escopo @dz23-studio dentro de node_modules', () => {
    criar('node_modules/outra-coisa/package.json')
    expect(observar(base).studioInstalado).toBe(false)
    criar('node_modules/@dz23-studio/prompt-to-app/package.json')
    expect(observar(base).studioInstalado).toBe(true)
  })

  it('o Studio compilado é a lib de um plugin, e não o código-fonte dele', () => {
    criar('plugins/prompt-to-app/src/index.ts')
    expect(observar(base).studioCompilado).toBe(false)
    criar('plugins/prompt-to-app/lib/index.js')
    expect(observar(base).studioCompilado).toBe(true)
  })

  it('o perfil é o package.json do perfil studio, e não a pasta dsh-home', () => {
    mkdirSync(resolve(base, 'dsh-home', 'profiles', 'studio'), { recursive: true })
    expect(observar(base).perfilPresente).toBe(false)
    criar('dsh-home/profiles/studio/package.json')
    expect(observar(base).perfilPresente).toBe(true)
  })
})

describe('observar + conferencias — o clone recém-baixado', () => {
  it('manda fazer UMA coisa: iniciar o submódulo', () => {
    // Este é o estado exato em que alguém abre o produto pela primeira vez.
    writeFileSync(resolve(base, '.nvmrc'), `${process.versions.node}\n`)
    const lista = conferencias(observar(base))
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
