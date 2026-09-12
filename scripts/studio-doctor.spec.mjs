import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { avisos, bloqueios, conferencias, primeiroPasso, relatorio, versaoEsperada } from './studio-doctor.mjs'

/**
 * O doctor da primeira execução.
 *
 * Cada teste aqui protege uma frase que uma pessoa que NÃO PROGRAMA vai ler
 * quando o Studio não abrir. É a única camada do produto cujo defeito aparece
 * antes da primeira tela — e, quando ela erra, o que sobra é o stack trace que
 * este arquivo inteiro existe para substituir.
 */

/** Um ambiente em que tudo está no lugar. */
function tudoPronto(overrides = {}) {
  return {
    nodeVersion: 'v22.23.1',
    nodeEsperado: '22.23.1',
    submoduloPresente: true,
    harnessInstalado: true,
    harnessCompilado: true,
    arranqueResolvivel: true,
    studioInstalado: true,
    studioCompilado: true,
    perfilPresente: true,
    docker: true,
    rotasConfiguradas: 1,
    ...overrides,
  }
}

const de = (lista, id) => lista.find(item => item.id === id)

describe('conferencias — o ambiente inteiro no lugar', () => {
  it('nada bloqueia e nada fica pendente', () => {
    const lista = conferencias(tudoPronto())
    expect(bloqueios(lista)).toEqual([])
    expect(avisos(lista)).toEqual([])
    expect(primeiroPasso(lista)).toBeUndefined()
  })

  it('toda conferência que FALTA diz o que fazer', () => {
    // Um diagnóstico sem próximo passo transfere o problema para quem não tem
    // como resolvê-lo. A regra vale para as onze, e não para as que eu lembrei.
    const lista = conferencias({})
    for (const item of lista) {
      if (item.estado !== 'FALTA') continue
      expect(item.faca, item.id).toBeTruthy()
      expect(item.porque, item.id).toBeTruthy()
    }
  })

  it('toda conferência tem um dos três estados, e todas tem titulo e o que viu', () => {
    for (const observado of [tudoPronto(), {}]) {
      for (const item of conferencias(observado)) {
        expect(['OK', 'FALTA', 'NAO_SEI'], item.id).toContain(item.estado)
        expect(item.titulo, item.id).toBeTruthy()
        expect(item.viu, item.id).toBeTruthy()
      }
    }
  })
})

describe('conferencias — a ordem é a da CAUSA', () => {
  it('o Harness vem antes do Studio, e a partida antes do que ela carrega', () => {
    // Ordenar por gravidade mandaria a pessoa comecar pelo passo que ela ainda
    // nao pode dar: instalar o Studio antes do Harness nao adianta.
    const ids = conferencias(tudoPronto()).map(item => item.id)
    expect(ids).toEqual([
      'node', 'submodulo', 'harness-instalado', 'harness-compilado', 'arranque',
      'studio-instalado', 'studio-compilado', 'perfil', 'construtor', 'modelo',
    ])
  })

  it('com tudo faltando, o primeiro passo e o submodulo — a raiz de todo o resto', () => {
    const lista = conferencias({ nodeVersion: 'v22.23.1', nodeEsperado: '22.23.1' })
    expect(primeiroPasso(lista).id).toBe('submodulo')
    expect(primeiroPasso(lista).faca).toContain('git submodule')
  })
})

describe('conferencias — o que bloqueia e o que nao bloqueia', () => {
  it('as oito primeiras bloqueiam: sem qualquer uma delas o Studio nao sobe', () => {
    const lista = conferencias(tudoPronto())
    for (const id of ['node', 'submodulo', 'harness-instalado', 'harness-compilado', 'arranque', 'studio-instalado', 'studio-compilado', 'perfil']) {
      expect(de(lista, id).bloqueia, id).toBe(true)
    }
  })

  it('construtor e modelo NAO bloqueiam: o Studio abre e diz na tela o que falta', () => {
    // Bloquear aqui impediria a pessoa de ver o produto por causa de algo que
    // ela conserta depois, de dentro dele.
    const lista = conferencias(tudoPronto({ docker: false, rotasConfiguradas: 0 }))
    expect(bloqueios(lista)).toEqual([])
    expect(avisos(lista).map(item => item.id)).toEqual(['construtor', 'modelo'])
  })

  it('o construtor ausente manda abrir o Docker, e nao reprova o arranque', () => {
    const lista = conferencias(tudoPronto({ docker: false }))
    expect(de(lista, 'construtor').estado).toBe('FALTA')
    expect(de(lista, 'construtor').faca).toContain('Docker')
    expect(bloqueios(lista)).toEqual([])
  })
})

describe('conferencias — NAO_SEI nunca vira FALTA', () => {
  it('nao ter conseguido perguntar ao Docker nao acusa o Docker de estar parado', () => {
    // "Nao consegui olhar" e uma resposta diferente de "esta faltando", e
    // junta-las mandaria a pessoa consertar algo que talvez esteja certo.
    const lista = conferencias(tudoPronto({ docker: undefined }))
    expect(de(lista, 'construtor').estado).toBe('NAO_SEI')
    expect(de(lista, 'construtor').faca).toBeUndefined()
    expect(avisos(lista).map(item => item.id)).toEqual(['construtor'])
  })

  it('nao ter conseguido ler as rotas nao afirma que nenhuma foi configurada', () => {
    const lista = conferencias(tudoPronto({ rotasConfiguradas: undefined }))
    expect(de(lista, 'modelo').estado).toBe('NAO_SEI')
  })

  it('versao do Node ilegivel e NAO_SEI, e nao impede o arranque', () => {
    const lista = conferencias(tudoPronto({ nodeVersion: undefined }))
    expect(de(lista, 'node').estado).toBe('NAO_SEI')
    expect(bloqueios(lista)).toEqual([])
  })
})

describe('conferencias — a versao do Node', () => {
  it('versao MAIOR diferente bloqueia, e diz qual instalar', () => {
    const lista = conferencias(tudoPronto({ nodeVersion: 'v20.11.0' }))
    expect(de(lista, 'node').estado).toBe('FALTA')
    expect(de(lista, 'node').viu).toContain('Node 22')
    expect(de(lista, 'node').faca).toContain('22.23.1')
    expect(bloqueios(lista).map(item => item.id)).toEqual(['node'])
  })

  it('versao menor diferente NAO bloqueia — mas E DITA', () => {
    // Recusar o 22.22 porque a prova foi feita no 22.23 impediria a pessoa de
    // usar o produto por uma diferenca que ela nao tem como julgar. Esconder a
    // diferenca seria o erro oposto: se algo estranho acontecer, essa linha e a
    // primeira coisa que alguem vai querer saber.
    const lista = conferencias(tudoPronto({ nodeVersion: 'v22.22.2' }))
    expect(de(lista, 'node').estado).toBe('OK')
    expect(de(lista, 'node').viu).toContain('22.22.2')
    expect(de(lista, 'node').viu).toContain('22.23.1')
    expect(bloqueios(lista)).toEqual([])
  })

  it('o `v` na frente nao inventa uma diferenca', () => {
    expect(de(conferencias(tudoPronto({ nodeVersion: 'v22.23.1', nodeEsperado: 'v22.23.1' })), 'node').viu).toBe('v22.23.1')
    expect(de(conferencias(tudoPronto({ nodeVersion: '22.23.1' })), 'node').viu).toBe('22.23.1')
  })

  it('sem versao fixada o doctor NAO recusa o ambiente', () => {
    // Inventar um numero para comparar faria o doctor reprovar uma maquina
    // correta — que e exatamente o defeito que ele existe para nao cometer.
    const lista = conferencias(tudoPronto({ nodeEsperado: undefined, nodeVersion: 'v18.0.0' }))
    expect(de(lista, 'node').estado).toBe('OK')
    expect(bloqueios(lista)).toEqual([])
  })
})

describe('primeiroPasso — UMA coisa por vez', () => {
  it('com varios bloqueios, devolve so o primeiro', () => {
    // Mostrar oito coisas faltando de uma vez para quem nao programa e a mesma
    // paralisia que o stack trace causava.
    const lista = conferencias(tudoPronto({ harnessInstalado: false, harnessCompilado: false, studioCompilado: false }))
    expect(bloqueios(lista)).toHaveLength(3)
    expect(primeiroPasso(lista).id).toBe('harness-instalado')
  })

  it('um aviso pendente NAO vira primeiro passo', () => {
    expect(primeiroPasso(conferencias(tudoPronto({ docker: false })))).toBeUndefined()
  })
})

describe('relatorio', () => {
  it('o ambiente pronto nao diz nada', () => {
    expect(relatorio(conferencias(tudoPronto()))).toBe([
      '  ok A versão do Node.js: v22.23.1',
      '  ok O Harness fixado, baixado: o Harness está no lugar',
      '  ok As dependências do Harness: instaladas',
      '  ok O Harness compilado: compilado',
      '  ok O pacote que dá a partida: encontrado',
      '  ok As dependências do Studio: instaladas',
      '  ok O Studio compilado: compilado',
      '  ok O perfil do Studio: no lugar',
      '  ok O ambiente isolado de criação: respondendo',
      '  ok A inteligência artificial: 1 configurada(s)',
    ].join('\n'))
  })

  it('o bloqueio aparece com o comando exato, e NUNCA com uma pilha do Node', () => {
    const texto = relatorio(conferencias(tudoPronto({ arranqueResolvivel: false })))
    expect(texto).toContain('O Studio ainda não pode abrir.')
    expect(texto).toContain('Rode este comando:')
    expect(texto).toContain("pnpm install --frozen-lockfile --filter '@dz23-studio/*...'")
    expect(texto).not.toContain('ERR_MODULE_NOT_FOUND')
    expect(texto).not.toContain('node:internal')
  })

  it('com mais de um bloqueio, diz QUANTOS faltam e que vem um por vez', () => {
    const texto = relatorio(conferencias(tudoPronto({ harnessInstalado: false, studioCompilado: false })))
    expect(texto).toContain('Ainda faltam outros 1 passo(s)')
    // E mostra o comando de UM so.
    expect(texto).toContain('pnpm --dir third_party/deepseek-harness install')
    expect(texto).not.toContain('\n  pnpm build')
  })

  it('com um unico bloqueio, NAO promete passos seguintes que nao existem', () => {
    expect(relatorio(conferencias(tudoPronto({ perfilPresente: false })))).not.toContain('Ainda faltam')
  })

  it('sem bloqueio e com pendencia, diz que o Studio ABRE — e o que ele nao vai conseguir fazer', () => {
    const texto = relatorio(conferencias(tudoPronto({ docker: false })))
    // "Nao abre" e "abre e nao cria aplicativo" mandam a pessoa fazer coisas
    // diferentes, e por isso sao duas frases diferentes.
    expect(texto).toContain('O Studio vai abrir.')
    expect(texto).not.toContain('ainda não pode abrir')
    expect(texto).toContain('O ambiente isolado de criação: não respondeu')
  })

  it('a pendencia sem comando nao deixa um traco solto no fim da linha', () => {
    const texto = relatorio(conferencias(tudoPronto({ docker: undefined })))
    for (const linha of texto.split('\n')) expect(linha).toBe(linha.trimEnd())
  })

  it('o bloqueio esconde as pendencias: elas nao sao o que a pessoa deve fazer agora', () => {
    const texto = relatorio(conferencias(tudoPronto({ perfilPresente: false, docker: false })))
    expect(texto).toContain('O Studio ainda não pode abrir.')
    expect(texto).not.toContain('O Studio vai abrir.')
  })

  it('cada estado tem a propria marca, e a marca do bloqueio se destaca', () => {
    const texto = relatorio(conferencias(tudoPronto({ arranqueResolvivel: false, docker: undefined })))
    expect(texto).toContain(' >>> O pacote que dá a partida:')
    expect(texto).toContain('  ?  O ambiente isolado de criação:')
    expect(texto).toContain('  ok O Harness compilado:')
  })

  it('o que FALTA sem bloquear NAO usa a marca do que bloqueia', () => {
    // Achado da execucao real neste contêiner: o Docker parado aparecia com o
    // mesmo `>>>` do impedimento de verdade, e so um dos dois tinha explicacao
    // logo abaixo. Duas causas na mesma coluna viram uma causa so para quem le.
    const texto = relatorio(conferencias(tudoPronto({ arranqueResolvivel: false, docker: false })))
    expect(texto).toContain(' >>> O pacote que dá a partida: não encontrado')
    expect(texto).toContain('  !  O ambiente isolado de criação: não respondeu')
    expect(texto.split('\n').filter(linha => linha.startsWith(' >>> '))).toHaveLength(1)
  })
})

describe('versaoEsperada', () => {
  const comArquivo = conteudo => {
    const pasta = mkdtempSync(resolve(tmpdir(), 'dz23-nvmrc-'))
    if (conteudo !== null) writeFileSync(resolve(pasta, '.nvmrc'), conteudo)
    try { return versaoEsperada(pasta) } finally { rmSync(pasta, { recursive: true, force: true }) }
  }

  it('le a versao do .nvmrc, sem o `v` e sem o espaco em branco', () => {
    expect(comArquivo('v22.23.1\n')).toBe('22.23.1')
    expect(comArquivo('22.23.1')).toBe('22.23.1')
  })

  it('arquivo AUSENTE devolve indefinido, e nunca um numero inventado', () => {
    expect(comArquivo(null)).toBeUndefined()
  })

  it('arquivo VAZIO tambem devolve indefinido', () => {
    // Um `.nvmrc` em branco compararia a versao atual contra a string vazia, e
    // reprovaria toda maquina do mundo.
    expect(comArquivo('  \n')).toBeUndefined()
  })

  it('o .nvmrc do repositorio existe e e a versao que o produto anuncia', () => {
    // Sem ele o doctor responderia NAO_SEI para a unica conferencia que a
    // pessoa nao tem como investigar sozinha.
    expect(versaoEsperada(new URL('..', import.meta.url).pathname)).toMatch(/^\d+\.\d+\.\d+$/u)
  })
})

describe('docs/COMECAR.md — a pagina e o codigo dizem a mesma coisa', () => {
  const pagina = readFileSync(new URL('../docs/COMECAR.md', import.meta.url), 'utf8')

  it('todo comando que o doctor manda rodar esta na pagina, letra por letra', () => {
    // Uma pagina que ensina um comando e um doctor que manda outro deixam a
    // pessoa escolher entre duas verdades — e ela nao tem como julgar qual.
    const comandos = new Set(conferencias({}).map(item => item.faca).filter(faca => faca !== undefined && /^(git|pnpm) /u.test(faca)))
    expect(comandos.size).toBeGreaterThan(0)
    for (const comando of comandos) expect(pagina, comando).toContain(comando)
  })

  it('as quatro marcas da tabela sao as quatro que o relatorio imprime', () => {
    const texto = relatorio(conferencias(tudoPronto({ arranqueResolvivel: false, docker: false, rotasConfiguradas: undefined })))
    // So o bloco das conferencias: ele termina na primeira linha em branco, e
    // o que vem depois e a prosa que explica o primeiro passo.
    const bloco = texto.split('\n\n')[0].split('\n')
    expect(bloco).toHaveLength(conferencias(tudoPronto()).length)
    const marcas = new Set(bloco.map(linha => linha.slice(0, 5).trim()))
    expect(marcas).toEqual(new Set(['ok', '>>>', '!', '?']))
    for (const marca of marcas) expect(pagina, marca).toContain(`\`${marca}\``)
  })

  it('a pagina nao promete um endereco fixo que o Harness nao garante', () => {
    // Quem escolhe a porta e o Harness, e ele a imprime. Escrever um
    // `localhost:3000` aqui seria um numero que ninguem prometeu.
    expect(pagina).not.toMatch(/localhost:\d+/u)
  })
})
