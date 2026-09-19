/**
 * ANEXAR um arquivo de texto ao pedido.
 *
 * Pedido do titular em 19/09/2026, com a tela na mão: "está limitado de
 * caracteres, não tem opção de anexar arquivo". O limite do compositor era 1000
 * enquanto o servidor aceitava 10.000 — a tela cortava o que o produto
 * aguentava —, e o anexo tinha uma frase no catálogo dizendo que não existia.
 *
 * Esta primeira versão é HONESTA sobre o que faz: o conteúdo do arquivo entra
 * no pedido, visível e editável, marcado com o nome do arquivo. Nada é enviado
 * escondido, e o que não cabe é cortado com aviso. Só texto: o modelo local não
 * lê imagem, e fingir que lê seria pior que não oferecer.
 */

import home from '../i18n/home.pt-BR.json'

export const LIMITE_DO_PEDIDO = 10_000

/** Extensões aceitas: texto que o modelo consegue ler como está. */
export const TIPOS_DE_ANEXO = '.txt,.md,.markdown,.csv,.tsv,.json,.yml,.yaml,.xml,.html,.htm,.log,.sql,.ini,.toml'

/** Tamanho máximo de arquivo lido (o pedido inteiro cabe em 10.000 caracteres). */
export const ARQUIVO_MAXIMO_BYTES = 512 * 1024

export interface PedidoComAnexo {
  readonly texto: string
  /** Quantos caracteres do arquivo ficaram de fora. */
  readonly cortados: number
}

/**
 * Junta o conteúdo do arquivo ao pedido, dentro do limite.
 * @param atual - o pedido como está.
 * @param nome - o nome do arquivo.
 * @param conteudo - o texto do arquivo.
 * @param limite - o limite do pedido.
 * @returns o pedido novo e quanto foi cortado.
 */
export function anexarAoPedido(atual: string, nome: string, conteudo: string, limite = LIMITE_DO_PEDIDO): PedidoComAnexo {
  const nomeLimpo = nome.replace(/[\r\n[\]]/gu, ' ').slice(0, 120)
  const cabeca = atual.trimEnd() + (atual.trim() === '' ? '' : '\n\n') + '[' + home.anexoMarca + ': ' + nomeLimpo + ']\n'
  const espaco = Math.max(0, limite - cabeca.length)
  const corpo = conteudo.replace(/\r\n/gu, '\n').trim()
  if (espaco === 0) return { texto: atual, cortados: corpo.length }
  return { texto: cabeca + corpo.slice(0, espaco), cortados: Math.max(0, corpo.length - espaco) }
}
