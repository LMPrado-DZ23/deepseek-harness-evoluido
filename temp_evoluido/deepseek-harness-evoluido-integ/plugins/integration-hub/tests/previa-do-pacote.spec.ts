import { describe, expect, it } from 'vitest'
import { createZip, listZip, readZip, zipHeaders } from '../src/zip.ts'

/**
 * A PRÉVIA lista o que há dentro sem materializar o conteúdo.
 *
 * O ganho não é de estilo: `readZip` descompacta tudo e pode segurar meio
 * gigabyte de memória para responder a uma pergunta que o diretório central já
 * responde. O risco do atalho seria escrever um segundo leitor — e um segundo
 * leitor de formato hostil é onde a conferência estrutural diverge em silêncio.
 */
describe('listar sem descompactar', () => {
  const pacote = createZip([
    { name: 'app/index.html', data: Buffer.from('<h1>olá</h1>') },
    { name: 'app/estilo.css', data: Buffer.from('body{margin:0}'.repeat(50)) },
    { name: 'LEIA.md', data: Buffer.from('') },
  ])

  it('devolve nome e tamanho DESCOMPACTADO de cada entrada', () => {
    expect(listZip(pacote)).toEqual([
      // 13, e não 12: `á` são DOIS bytes em UTF-8, e o tamanho é em bytes.
      { name: 'app/index.html', size: Buffer.byteLength('<h1>olá</h1>') },
      { name: 'app/estilo.css', size: 'body{margin:0}'.repeat(50).length },
      { name: 'LEIA.md', size: 0 },
    ])
  })

  it('entrada VAZIA aparece com tamanho zero, e não some da lista', () => {
    expect(listZip(pacote).map(entrada => entrada.name)).toContain('LEIA.md')
  })

  it('a lista e a leitura completa CONCORDAM — há um leitor só', () => {
    // Se um dia elas discordarem, é porque alguém escreveu o segundo leitor.
    expect(listZip(pacote)).toEqual(readZip(pacote).map(entrada => ({ name: entrada.name, size: entrada.data.length })))
  })

  it('a conferência estrutural continua valendo na lista: arquivo corrompido é recusado', () => {
    const corrompido = Buffer.from(pacote)
    // Estraga a assinatura do diretório central.
    corrompido.writeUInt32LE(0x00000000, corrompido.length - 22)
    expect(() => listZip(corrompido)).toThrow()
  })

  it('a lista NÃO toca no conteúdo — e isto se prova com o conteúdo quebrado', () => {
    /*
      A sabotagem que fez `listZip` delegar para `readZip` SOBREVIVEU: a saída
      é a mesma, e só o custo muda. Um teste que compara saída nunca pega isso.

      Este pega. Um pacote com o PAYLOAD corrompido — a estrutura intacta, os
      bytes do conteúdo trocados — é ilegível para quem descompacta e continua
      perfeitamente listável para quem lê só o diretório central. Se um dia a
      lista voltar a descompactar, ela passa a falhar aqui.
    */
    const quebrado = Buffer.from(createZip([
      { name: 'grande.txt', data: Buffer.from('conteúdo que será estragado'.repeat(20)) },
    ]))
    const cabecalho = zipHeaders(quebrado)[0]!
    // Troca um byte NO MEIO do payload: os offsets e os tamanhos continuam os
    // mesmos, então nada da estrutura muda.
    quebrado[cabecalho.start + 3] = (quebrado[cabecalho.start + 3]! ^ 0xff)

    expect(() => readZip(quebrado)).toThrow()
    // Em BYTES, e não em caracteres: os acentos ocupam dois.
    expect(listZip(quebrado)).toEqual([{ name: 'grande.txt', size: Buffer.byteLength('conteúdo que será estragado'.repeat(20)) }])
  })

  it('o cabeçalho traz onde o payload começa, já conferido', () => {
    for (const cabecalho of zipHeaders(pacote)) {
      expect(cabecalho.start).toBeGreaterThan(0)
      expect(cabecalho.start + cabecalho.compressedSize).toBeLessThanOrEqual(pacote.length)
    }
  })
})
