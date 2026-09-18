/**
 * A INTERPOLAÇÃO de um texto traduzido, e o jeito de descobrir que ela falhou.
 *
 * ## Por que isto existe
 *
 * Porque a interpolação estava sendo feita com `.replace('{n}', …)` solto no
 * meio do JSX. Isso tem três defeitos que só aparecem quando já é tarde:
 *
 * 1. **Um marcador escrito errado não falha** — `{ n }` com espaços, `{num}`
 *    numa tradução: o `replace` não acha nada, devolve o texto como estava, e a
 *    pessoa lê `{n}` na tela.
 * 2. **Um marcador a mais fica invisível** — se o português tem `{n}` e o
 *    espanhol tem `{n}` e `{total}`, ninguém preenche o segundo.
 * 3. **A ordem das palavras é do tradutor, não do programador.** Montar a frase
 *    com `${a}: ${b}` no código fixa uma ordem que em outra língua está errada.
 *    É exatamente por isso que a AÇÃO acessível da marca vem do catálogo com um
 *    marcador `{marca}` dentro, em vez de o código concatenar nome e ação.
 *
 * ## O que ele NÃO faz
 *
 * Não lança. Uma preferência de apresentação não derruba a tela: `comValores`
 * substitui o que pode e devolve. Quem transforma "sobrou marcador" em falha é
 * `marcadoresPendentes`, usado pelos testes das superfícies traduzidas — o lugar
 * certo para isso ser barulhento é a suíte, e não a mão de quem está usando.
 */

/** Um marcador é `{nome}`, com o nome em letras e números. */
const MARCADOR = /\{([A-Za-z][A-Za-z0-9]*)\}/gu

/**
 * O texto com os marcadores substituídos.
 *
 * Um marcador sem valor correspondente é DEIXADO como está, e não apagado:
 * apagá-lo produziria uma frase que parece correta e perdeu um dado — "Total
 * medido: em chamadas" —, enquanto um `{custo}` visível na tela é feio e
 * denuncia o defeito no primeiro olhar.
 * @param modelo - o texto do catálogo, com marcadores.
 * @param valores - o valor de cada marcador.
 * @returns o texto pronto.
 */
export function comValores(modelo: string, valores: Readonly<Record<string, string>>): string {
  return modelo.replace(MARCADOR, (inteiro, nome: string) => valores[nome] ?? inteiro)
}

/**
 * Os marcadores que sobraram num texto já interpolado.
 *
 * É o que um teste usa para afirmar que a tela não mostra `{n}` a ninguém.
 * @param texto - o texto pronto.
 * @returns os nomes dos marcadores que ficaram.
 */
export function marcadoresPendentes(texto: string): readonly string[] {
  return [...texto.matchAll(MARCADOR)].map(achado => achado[1] ?? '')
}
