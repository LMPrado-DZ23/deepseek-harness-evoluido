import type { ProjectUiState } from '../presentation'
import t from '../i18n/pt-BR.json'

/**
 * A situação do projeto EM PORTUGUÊS, por tabela exaustiva.
 *
 * `Record<ProjectUiState, string>` de propósito: um estado novo no tipo não
 * compila até alguém dizer o que ele significa para quem lê. Foi exatamente
 * assim que `BUDGET_EXCEEDED` chegou à interface sem frase própria uma vez, e a
 * lição está escrita em `presentation.ts`.
 *
 * `BUILD_OK` e `TESTS_OK` dizem "criando agora" porque é isso que eles são para
 * quem espera: passos intermediários de uma criação que não terminou.
 * Traduzi-los como "construção concluída" faria a lista anunciar um fim que não
 * houve — e essa é a mesma família de mentira que a frase permanente da tela de
 * verificação já cometeu uma vez.
 */
export const PROJECT_STATE_LABEL: Readonly<Record<ProjectUiState, string>> = t.projects.states

/**
 * A situação de um projeto, para a lista.
 * @param state - o estado vindo do servidor.
 * @returns a frase em português; o próprio código, se o servidor mandar um estado que este cliente não conhece.
 */
export function projectStateLabel(state: string): string {
  return Object.hasOwn(PROJECT_STATE_LABEL, state)
    ? PROJECT_STATE_LABEL[state as ProjectUiState]
    // Um servidor mais novo que o cliente não pode deixar a linha VAZIA: o
    // código cru é feio, e ainda assim é melhor do que uma célula em branco que
    // faz a pessoa achar que o projeto se perdeu.
    : state
}

/**
 * A data como uma pessoa lê, e não como o servidor grava.
 * @param iso - a data em ISO-8601.
 * @returns a data legível, ou o próprio texto quando ele não é uma data.
 */
export function readableDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })
}

/**
 * "1 projeto" e "2 projetos" — o plural existe porque "1 projetos" é o tipo de
 * detalhe que faz um produto parecer improvisado.
 * @param count - quantos projetos.
 * @returns a frase da contagem.
 */
export function projectCount(count: number): string {
  return (count === 1 ? t.projects.count : t.projects.countPlural).replace('{count}', String(count))
}
