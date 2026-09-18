#!/usr/bin/env node
/**
 * O PORTÃO DO PIX DE DOAÇÃO.
 *
 * Um BR Code errado não falha barulhento: ele falha na mão de quem quis doar, no
 * aplicativo do banco, sem ninguém do projeto ficar sabendo. Este portão existe
 * porque o custo de um caractere trocado aqui é dinheiro indo para o lugar
 * errado — ou para lugar nenhum — e porque nenhum teste de interface olha para
 * um payload EMV.
 *
 * ## As três coisas que ele confere
 *
 * 1. **O CRC-16 fecha.** O BR Code carrega um CRC-CCITT sobre todo o resto
 *    (`ISO/IEC 13239`, polinômio `0x1021`, semente `0xFFFF`). Trocar a chave, o
 *    nome ou a cidade sem recalcular o CRC produz um código que todo aplicativo
 *    de banco recusa. Este é o conserto "óbvio" que alguém vai tentar fazer um
 *    dia — corrigir um typo na chave direto no arquivo — e é o que este portão
 *    pega no mesmo minuto.
 * 2. **A estrutura é a de um PIX.** Campo `00` de formato, GUI
 *    `br.gov.bcb.pix` dentro do `26`, moeda `986` e país `BR`. Um payload que
 *    passa no CRC e não é PIX é outro código qualquer colado no lugar certo.
 * 3. **Quem exibe cita a FONTE, byte a byte.** O payload aparece em dois
 *    lugares para quem lê: o QR que se escaneia e o texto que se copia. Dois
 *    lugares com o mesmo dado escrito à mão é a segunda verdade de sempre, e
 *    aqui ela não produz um rótulo errado — produz um pagamento perdido.
 *
 * ## O que ele NÃO confere
 *
 * Que a chave EXISTE e é do titular. Isso não se descobre sem fazer um
 * pagamento, e este portão não faz rede. Um payload íntegro apontando para uma
 * chave que ninguém cadastrou passa aqui — e é por isso que a conferência da
 * chave é do titular, não do portão.
 *
 * Também não confere o PNG do QR. Ele é gerado de `docs/pix-payload.txt` por
 * `scripts/build-pix-qr.mjs`, e a leitura de volta da imagem foi feita uma vez,
 * na entrega, com um decodificador de verdade — está registrada no livro mestre.
 * Repetir isso no portão exigiria um decodificador de QR como dependência da
 * CI, e a troca não se paga.
 *
 * Uso: node scripts/check-pix.mjs [--self-test]
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const raiz = process.cwd()
const FONTE = 'docs/pix-payload.txt'
/** Onde o payload pode aparecer para quem lê. Cada um tem de citar a fonte inteira. */
const EXIBEM = ['README.md']

/**
 * O CRC-16/CCITT-FALSE de um texto, como o BR Code o define.
 * @param texto - o corpo do payload, SEM os quatro dígitos finais.
 * @returns o CRC em quatro dígitos hexadecimais maiúsculos.
 */
export function crcDoBrCode(texto) {
  let crc = 0xFFFF
  for (const byte of Buffer.from(texto, 'ascii')) {
    crc ^= byte << 8
    for (let volta = 0; volta < 8; volta += 1) {
      crc = (crc & 0x8000) === 0 ? (crc << 1) & 0xFFFF : ((crc << 1) ^ 0x1021) & 0xFFFF
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}

/**
 * Os campos de primeiro nível de um payload EMV, no formato `TTLLvalor`.
 * @param texto - o payload.
 * @returns um mapa de etiqueta para valor.
 */
export function camposEmv(texto) {
  const campos = new Map()
  let posicao = 0
  while (posicao + 4 <= texto.length) {
    const etiqueta = texto.slice(posicao, posicao + 2)
    const tamanho = Number.parseInt(texto.slice(posicao + 2, posicao + 4), 10)
    if (!Number.isInteger(tamanho) || tamanho < 0) return campos
    campos.set(etiqueta, texto.slice(posicao + 4, posicao + 4 + tamanho))
    posicao += 4 + tamanho
  }
  return campos
}

/**
 * Os achados de um payload e dos textos que o exibem.
 *
 * Extraída porque a decisão que mora no corpo do roteiro não é exercitada por
 * teste nenhum — a lição que este repositório aprendeu mais de dez vezes.
 * @param payload - o conteúdo da fonte.
 * @param exibicoes - caminho → conteúdo de cada arquivo que exibe o payload.
 * @returns os achados.
 */
export function achados(payload, exibicoes) {
  const lista = []
  const reprove = (onde, motivo) => lista.push({ onde, motivo })

  if (payload.length < 20) {
    reprove(FONTE, 'o payload é curto demais para ser um BR Code')
    return lista
  }
  if (payload !== payload.trim()) reprove(FONTE, 'o payload tem espaço ou quebra de linha nas pontas — eles entram no CRC e o invalidam')

  const corpo = payload.slice(0, -4)
  const informado = payload.slice(-4).toUpperCase()
  const calculado = crcDoBrCode(corpo)
  if (!corpo.endsWith('6304')) {
    reprove(FONTE, 'o payload não termina com o campo de CRC `6304`, que o BR Code exige como último')
  }
  if (informado !== calculado) {
    reprove(FONTE, `o CRC não fecha: o payload diz ${informado} e o cálculo dá ${calculado}. Um caractere foi trocado sem recalcular`)
  }

  const campos = camposEmv(payload)
  if (campos.get('00') === undefined) reprove(FONTE, 'não há campo `00` de formato do payload')
  if (!(campos.get('26') ?? '').includes('br.gov.bcb.pix')) reprove(FONTE, 'o campo `26` não carrega a GUI `br.gov.bcb.pix`: isto não é um PIX')
  if (campos.get('53') !== '986') reprove(FONTE, `a moeda é ${JSON.stringify(campos.get('53'))} e o PIX é 986 (real)`)
  if (campos.get('58') !== 'BR') reprove(FONTE, `o país é ${JSON.stringify(campos.get('58'))} e deveria ser BR`)

  for (const [caminho, conteudo] of exibicoes) {
    if (!conteudo.includes(payload)) {
      reprove(caminho, 'exibe um código de doação que NÃO é o da fonte, ou não o exibe inteiro')
    }
  }
  return lista
}

if (process.argv.includes('--self-test')) {
  let casos = 0
  const check = (condicao, mensagem) => { casos += 1; if (!condicao) { process.stdout.write(`PIX_SELF_TEST=FAIL ${mensagem}\n`); process.exit(1) } }
  const bom = readFileSync(resolve(raiz, FONTE), 'utf8').trim()
  check(crcDoBrCode('123456789') === '29B1', 'o CRC-16/CCITT-FALSE nao bate com o vetor conhecido 123456789')
  check(achados(bom, new Map([['x', `antes ${bom} depois`]])).length === 0, 'reprovou um payload correto')
  check(achados(bom, new Map([['x', 'sem o codigo']])).length === 1, 'nao pegou quem exibe outro codigo')
  check(achados(`${bom} `, new Map()).length > 0, 'aceitou espaco na ponta')
  check(achados(bom.slice(0, -1) + 'F', new Map()).length === 1, 'aceitou CRC trocado')
  check(achados(bom.replace('5303986', '5303840'), new Map()).length > 0, 'aceitou moeda que nao e o real')
  check(achados('curto', new Map()).length === 1, 'aceitou payload curto demais')
  check(camposEmv('00020101').get('00') === '01', 'nao leu um campo EMV simples')
  process.stdout.write(`PIX_SELF_TEST=PASS casos=${casos}\n`)
  process.exit(0)
}

const payload = readFileSync(resolve(raiz, FONTE), 'utf8')
const exibicoes = new Map(EXIBEM.map(caminho => [caminho, readFileSync(resolve(raiz, caminho), 'utf8')]))
const lista = achados(payload.trim() === payload ? payload : payload, exibicoes)

for (const { onde, motivo } of lista) process.stdout.write(`  ${onde}: ${motivo}\n`)
process.stdout.write(`PIX=${lista.length === 0 ? 'PASS' : 'FAIL'} fonte=${FONTE} exibem=${EXIBEM.join(',')} achados=${lista.length}\n`)
process.exitCode = lista.length === 0 ? 0 : 1
