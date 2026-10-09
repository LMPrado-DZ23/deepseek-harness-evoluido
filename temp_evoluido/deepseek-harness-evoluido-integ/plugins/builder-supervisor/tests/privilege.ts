/**
 * `true` quando a suíte roda como root.
 *
 * Três garantias desta suíte só existem para um usuário comum: root é dono de
 * tudo que cria, escreve onde a permissão diz que não pode, e é a exceção
 * legítima do carregador de registro (um arquivo de root, em 0600, não é
 * gravável pelo runtime e por isso é aceito). Rodando como root essas três
 * passam a reprovar um produto correto, e a única maneira de deixá-las verdes
 * seria afrouxar a checagem - o verde artificial que a missão proíbe.
 *
 * Então elas ficam em `runIf`/`skipIf`: a CI roda sem privilégio e continua
 * exigindo as três, e quem rodar como root vê um pulo declarado em vez de um
 * vermelho que mente sobre o produto.
 */
export const RUNNING_AS_ROOT = process.getuid?.() === 0
