import { expect, type Page } from '@playwright/test'

/**
 * O resultado da criação, onde ele passou a morar.
 *
 * MAPA DE EQUIVALÊNCIA — decisão de produto `DZ23-VISUAL-VIDEO-20260916-R1`.
 *
 * | afirmação anterior                                          | afirmação agora                                   |
 * | ----------------------------------------------------------- | ------------------------------------------------- |
 * | "As verificações declaradas passaram neste computador."      | idem, no painel de detalhamento                   |
 * | título "O que aconteceu na criação" na tela                  | idem, no mesmo painel                             |
 * | (não existia)                                                | o resultado aparece na CONVERSA, com o estado real |
 *
 * As duas afirmações antigas continuam sendo feitas, palavra por palavra: o
 * detalhamento não foi removido, ele deixou de ser o layout padrão e abre sob
 * demanda, que é exatamente o que a decisão pede. E uma afirmação NOVA foi
 * acrescentada — a de que o resultado chega na conversa —, porque era a
 * ausência dela que o proprietário recusou.
 *
 * Nada aqui usa `catch` nem `if`: um caminho alternativo silencioso é como um
 * teste aprende a passar quando a tela quebra.
 */

/** A frase que a conversa usa para uma tentativa aprovada. */
export const RESULTADO_NA_CONVERSA = 'Passou nas conferências desta tentativa'
/** A frase do detalhamento técnico, que continua existindo no painel. */
export const RESULTADO_NO_DETALHE = 'As verificações declaradas passaram neste computador.'
export const RELATO_NO_DETALHE = 'O que aconteceu na criação'

/**
 * Espera o resultado aparecer na conversa.
 * @param page - a página.
 * @param timeout - quanto esperar pela criação.
 */
export async function esperarResultado(page: Page, timeout = 40_000): Promise<void> {
  await expect(page.getByText(RESULTADO_NA_CONVERSA).first()).toBeVisible({ timeout })
}

/**
 * Abre o painel de detalhamento e confere que o relato antigo continua inteiro.
 *
 * Fechar no fim é parte da conferência: a decisão diz que "fechar retorna à
 * conversa com posição, rascunho e contexto preservados", e um painel que não
 * fecha não teria como cumprir isso.
 * @param page - a página.
 */
export async function abrirDetalhamento(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Ver o detalhamento técnico' }).click()
  await expect(page.getByText(RESULTADO_NO_DETALHE)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('heading', { name: RELATO_NO_DETALHE })).toBeVisible({ timeout: 20_000 })
}

/** Fecha o painel e confere que a conversa voltou. */
export async function fecharDetalhamento(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Fechar o painel' }).click()
  await expect(page.getByLabel('Conversa desta tarefa')).toBeVisible()
}
