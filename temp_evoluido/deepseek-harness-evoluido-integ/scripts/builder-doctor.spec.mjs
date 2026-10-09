import { describe, expect, it } from 'vitest'
import { bloqueios, relatorio } from './studio-doctor.mjs'
import { ASSUNTO_DO_CONSTRUTOR, ESPACO_ESTIMADO_GB, conferenciasDoConstrutor, espacoOndeAsImagensMoram } from './builder-doctor.mjs'

/**
 * Uma máquina pronta, para os casos quebrarem UM fato por vez.
 * @returns o observado de uma máquina onde dá para construir.
 */
function pronto() {
  return {
    dockerCliente: true, dockerDaemon: true, arquitetura: 'x64', imagemPresente: true,
    espacoLivreGb: 50, redeAlcancavel: true, redeBloqueada: [], submoduloPresente: true,
    sistemaDeArquivos: 'ext4', sistemaDeArquivosSuportado: true, instaladorPresente: true,
    modeloAlcancavel: true,
  }
}

describe('o conferidor do construtor', () => {
  it('a ORDEM e a da causa: sem cliente, o daemon nem e perguntado primeiro', () => {
    // Quem lê resolve o primeiro impedimento e roda de novo; por isso a ordem
    // tem de ser a da causa, e não a da gravidade.
    const ids = conferenciasDoConstrutor({ ...pronto(), dockerCliente: false, dockerDaemon: false })
      .filter(item => item.estado === 'FALTA').map(item => item.id)
    expect(ids[0]).toBe('docker-cliente')
  })

  it('com a imagem PRESENTE, rede e espaco deixam de bloquear', () => {
    /*
      A regra que evita mandar a pessoa resolver o que não a impede: quem já tem
      a imagem não precisa de registro nenhum, e o espaço que a estimativa pede
      é o espaço para CONSTRUIR a imagem.
    */
    const comImagem = conferenciasDoConstrutor({
      ...pronto(), imagemPresente: true, redeAlcancavel: false, redeBloqueada: ['mcr.microsoft.com'], espacoLivreGb: 1,
    })
    expect(bloqueios(comImagem)).toEqual([])
    const semImagem = conferenciasDoConstrutor({ ...pronto(), imagemPresente: false, redeAlcancavel: false, redeBloqueada: ['mcr.microsoft.com'], espacoLivreGb: 1 })
    expect(bloqueios(semImagem).map(item => item.id)).toEqual(['imagem', 'espaco', 'rede'])
  })

  it('o espaco DIZ que e estimativa, e nao medicao', () => {
    // Ninguém construiu esta imagem ainda. Afirmar "8 GB bastam" seria prometer
    // o que não se mediu.
    const item = conferenciasDoConstrutor({ ...pronto(), imagemPresente: false, espacoLivreGb: 2 }).find(candidato => candidato.id === 'espaco')
    expect(item?.viu).toContain(String(ESPACO_ESTIMADO_GB))
    expect(item?.porque).toContain('NÃO é medição')
  })

  it('o sistema de arquivos de /mnt/c bloqueia, e diz onde clonar', () => {
    const texto = relatorio(
      conferenciasDoConstrutor({ ...pronto(), sistemaDeArquivos: '9p', sistemaDeArquivosSuportado: false }),
      ASSUNTO_DO_CONSTRUTOR,
    )
    expect(texto).toContain('ext4')
    expect(texto).toContain('nunca em /mnt/c')
  })

  it('o fechamento e o DESTE conferidor, e nao o do Studio', () => {
    /*
      O renderizador é o mesmo de propósito — mesmas quatro marcas, mesma ordem
      por causa, mesmo "termine no próximo comando". O que muda é a pergunta que
      ele responde, e ela não pode sair errada: quem roda isto quer saber se dá
      para CONSTRUIR, e ler "o Studio ainda não pode abrir" mandaria a pessoa
      procurar defeito onde não há.
    */
    // Dois impedimentos de propósito: a frase de "rode de novo" só aparece
    // quando ainda resta passo depois do primeiro.
    const texto = relatorio(
      conferenciasDoConstrutor({ ...pronto(), imagemPresente: false, espacoLivreGb: 1, submoduloPresente: false }),
      ASSUNTO_DO_CONSTRUTOR,
    )
    expect(texto).toContain('O FRIGG ainda não consegue construir aqui')
    expect(texto).toContain('pnpm builder:doctor')
    expect(texto).not.toContain('O Studio ainda não pode abrir')
  })

  it('o modelo NAO bloqueia: construir e uma coisa, gerar e outra', () => {
    expect(bloqueios(conferenciasDoConstrutor({ ...pronto(), modeloAlcancavel: false }))).toEqual([])
  })

  it('o que nao pode ser perguntado vira NAO_SEI, e nunca uma falha inventada', () => {
    // `NÃO OBSERVADO` é resposta diferente de "falhou", e colapsá-las manda a
    // pessoa consertar o que talvez esteja certo.
    const lista = conferenciasDoConstrutor({ ...pronto(), dockerCliente: undefined, arquitetura: undefined, sistemaDeArquivos: undefined })
    expect(lista.filter(item => item.estado === 'NAO_SEI').map(item => item.id))
      .toEqual(['docker-cliente', 'arquitetura', 'sistema-de-arquivos'])
    expect(bloqueios(lista)).toEqual([])
  })
})

describe('onde o espaco e medido', () => {
  /*
    O DEFEITO MEDIDO na máquina do titular: a primeira versão media o disco do
    CLONE. Lá o clone está em `/mnt/c` (203 GB livres) e as imagens moram na
    raiz do daemon, no ext4 do WSL2 (880 GB). A resposta saía certa por acaso,
    e sobre o disco errado.
  */
  const sonda = (tabela) => ({ espacoLivreGb: caminho => tabela[caminho] })

  it('mede na RAIZ DO DOCKER, e diz onde mediu', () => {
    expect(espacoOndeAsImagensMoram('/var/lib/docker', sonda({ '/var/lib/docker': 880, '/mnt/c/clone': 203 })))
      .toEqual({ espacoLivreGb: 880, espacoMedidoEm: '/var/lib/docker' })
  })

  it('raiz recusada, mede o diretorio de cima — e o texto diz que foi ali', () => {
    const medido = espacoOndeAsImagensMoram('/var/lib/docker', sonda({ '/var/lib': 870 }))
    expect(medido).toEqual({ espacoLivreGb: 870, espacoMedidoEm: '/var/lib' })
    const item = conferenciasDoConstrutor({ ...pronto(), imagemPresente: false, ...medido })
      .find(candidato => candidato.id === 'espaco')
    expect(item?.viu).toContain('em /var/lib')
  })

  it('sem daemon, NAO SEI — e nunca o disco do clone fingindo ser o das imagens', () => {
    expect(espacoOndeAsImagensMoram(undefined, sonda({ '/mnt/c/clone': 203 }))).toEqual({})
    const item = conferenciasDoConstrutor({ ...pronto(), espacoLivreGb: undefined }).find(candidato => candidato.id === 'espaco')
    expect(item?.estado).toBe('NAO_SEI')
  })
})

describe('a imagem e procurada pelo digest FIXADO', () => {
  /*
    A primeira versão procurava uma tag que eu inventei, enquanto o caminho que
    já existe — `scripts/setup-templates.mjs` — grava o ID em
    `runtime/builder-image-digest`. A ADR-020 diz qual vale: o runtime só aceita
    o `sha256:` completo, nunca tag mutável.
  */
  it('le o digest do arquivo que o setup grava, e so aceita a forma completa', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { lerDigestFixado } = await import('./builder-doctor.mjs')
    const base = mkdtempSync(join(tmpdir(), 'digest-'))
    mkdirSync(join(base, 'runtime'))
    expect(lerDigestFixado(base)).toBeUndefined()
    writeFileSync(join(base, 'runtime/builder-image-digest'), `sha256:${'a'.repeat(64)}\n`)
    expect(lerDigestFixado(base)).toBe(`sha256:${'a'.repeat(64)}`)
    // Tag não é digest, e tratá-la como tal mandaria o Docker procurar lixo.
    writeFileSync(join(base, 'runtime/builder-image-digest'), 'dz23-studio-builder:local\n')
    expect(lerDigestFixado(base)).toBeUndefined()
  })

  it('nunca construida e fixada-e-sumida sao respostas DIFERENTES', () => {
    const nunca = conferenciasDoConstrutor({ ...pronto(), imagemPresente: false }).find(item => item.id === 'imagem')
    const sumida = conferenciasDoConstrutor({ ...pronto(), imagemPresente: false, digestFixado: `sha256:${'b'.repeat(64)}` })
      .find(item => item.id === 'imagem')
    expect(nunca?.faca).toBe('node scripts/setup-templates.mjs --approve-t2')
    // Com o digest fixado, o setup recusa sem `--replace-existing` — mandar o
    // comando sem ele seria mandar a pessoa bater numa recusa.
    expect(sumida?.faca).toBe('node scripts/setup-templates.mjs --approve-t2 --replace-existing')
    expect(nunca?.viu).not.toBe(sumida?.viu)
  })
})
