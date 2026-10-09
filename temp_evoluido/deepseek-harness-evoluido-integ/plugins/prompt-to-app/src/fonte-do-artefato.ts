import { z } from 'zod'

/**
 * O CÓDIGO da versão, servido para quem pediu a versão.
 *
 * ## Por que a lista branca vem do RELATO, e não do disco
 *
 * O jeito comum de servir um arquivo de dentro de um diretório é normalizar o
 * caminho e conferir que ele continua debaixo da raiz. Isso funciona e é
 * frágil: cada nova forma de escrever o mesmo caminho — codificação percentual,
 * barra invertida, ligação simbólica, normalização Unicode — é uma chance nova
 * de a conferência discordar do sistema de arquivos, e quem ganha a discordância
 * é o sistema de arquivos.
 *
 * Aqui a pergunta é outra: este caminho ESTÁ na lista que o relato da execução
 * declara? O relato é gravado pelo próprio produto, com os arquivos que ele
 * escreveu naquela tentativa. Um caminho que não está lá não é servido, por mais
 * bem formado que ele seja — e nenhum `..` inventa uma entrada numa lista.
 *
 * A comparação é por igualdade EXATA da forma normalizada, e a forma normalizada
 * é calculada dos dois lados pela mesma função.
 *
 * ## O que este arquivo NÃO faz
 *
 * Não lê disco. Ele decide O QUE pode ser lido; quem lê é o manipulador HTTP, e
 * é lá que mora o caminho absoluto. A separação é o que permite exercitar a
 * decisão inteira sem sistema de arquivos nenhum.
 */

export class FonteNaoServida extends Error {
  readonly code: 'FONTE_FORA_DA_LISTA' | 'FONTE_GRANDE_DEMAIS' = 'FONTE_FORA_DA_LISTA'
}

export class FonteGrandeDemais extends FonteNaoServida {
  readonly code = 'FONTE_GRANDE_DEMAIS'
}

/** O teto de UM arquivo servido. Um arquivo gerado enorme não vira resposta enorme. */
export const LIMITE_DA_FONTE = 256 * 1024

/** O relato, na parte que interessa aqui: quais arquivos aquela tentativa escreveu. */
export const relatoComArquivosSchema = z.object({
  files: z.array(z.object({ path: z.string().min(1) }).loose()).default([]),
}).loose()

/**
 * A forma normalizada de um caminho, para os dois lados da comparação.
 *
 * Barra invertida vira barra, `./` some, e a barra do começo some. O que ela
 * deliberadamente NÃO faz é resolver `..`: um caminho com `..` não é
 * normalizado até virar outro, ele é simplesmente recusado, porque nenhum
 * arquivo que o produto escreveu tem `..` no nome.
 * @param caminho - o caminho como ele veio.
 * @returns a forma normalizada.
 */
export function formaNormalizada(caminho: string): string {
  return caminho.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/^\/+/u, '')
}

/**
 * Se este caminho está na lista que o relato declara.
 * @param declarados - os caminhos do relato.
 * @param pedido - o caminho pedido.
 * @returns o caminho DECLARADO correspondente, ou `null`.
 */
export function caminhoDeclarado(declarados: readonly string[], pedido: string): string | null {
  const alvo = formaNormalizada(pedido)
  if (alvo === '' || alvo.split('/').some(parte => parte === '..' || parte === '')) return null
  return declarados.find(declarado => formaNormalizada(declarado) === alvo) ?? null
}

/**
 * O caminho a ler, ou a recusa.
 * @param relato - o relato da execução, como ele foi gravado.
 * @param pedido - o caminho pedido pela tela.
 * @returns o caminho declarado a ler.
 */
export function fonteAServir(relato: unknown, pedido: string): string {
  const lido = relatoComArquivosSchema.safeParse(relato)
  const declarados = lido.success ? lido.data.files.map(arquivo => arquivo.path) : []
  const encontrado = caminhoDeclarado(declarados, pedido)
  if (encontrado === null) throw new FonteNaoServida(pedido)
  return encontrado
}

/**
 * O conteúdo que atravessa, ou a recusa por tamanho.
 *
 * Cortar seria pior que recusar: um arquivo pela metade parece um arquivo, e a
 * pessoa leria código que não é o que está lá. A recusa diz o tamanho, para ela
 * saber que o arquivo existe e por que ele não coube.
 * @param conteudo - o que foi lido do disco.
 * @returns o mesmo conteúdo, quando ele cabe.
 */
export function conteudoQueCabe(conteudo: string): string {
  if (Buffer.byteLength(conteudo, 'utf8') > LIMITE_DA_FONTE) throw new FonteGrandeDemais(String(LIMITE_DA_FONTE))
  return conteudo
}
