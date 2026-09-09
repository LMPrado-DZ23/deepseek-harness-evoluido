import { expect, type Page } from '@playwright/test'

/**
 * Responde as perguntas da etapa de intake, uma por vez, ESPERANDO o Studio
 * absorver cada resposta antes de digitar a próxima.
 *
 * Existe por causa de uma corrida real, que reprovou
 * `pending.spec.ts` em 1 de 3 repetições e nunca duas vezes no mesmo lugar:
 * o laço original era `fill` seguido de `click`, sem nada entre uma volta e
 * outra. Quando a resposta anterior demorava, o `fill` da volta seguinte
 * escrevia no campo da pergunta VELHA; a resposta chegava logo depois, a
 * pergunta nova renderizava, o campo era limpo — e o texto recém-digitado ia
 * embora com ele. O botão então ficava desabilitado para sempre (campo vazio),
 * e o teste esperava sessenta segundos por um clique que nunca poderia
 * acontecer.
 *
 * O sintoma parecia defeito do produto e não era: era o teste digitando cedo
 * demais. Um teste que falha por pressa ensina a equipe a reexecutar a suíte
 * até passar, que é como uma falha de verdade aprende a se esconder.
 *
 * A espera é `desabilitado E aria-busy="false"`, que é exatamente o estado
 * "pronto para receber a próxima resposta":
 *
 * - campo vazio e nada no ar  → desabilitado, `aria-busy="false"`  ← aqui
 * - campo preenchido          → habilitado
 * - resposta em voo           → desabilitado, `aria-busy="true"`
 *
 * Nenhum outro estado casa com os dois ao mesmo tempo, então a espera não pode
 * passar cedo.
 */
export async function answerIntake(page: Page, answers: readonly string[]): Promise<void> {
  const responder = page.getByRole('button', { name: 'Responder e continuar' })
  for (const answer of answers) {
    await expect(responder).toBeDisabled()
    await expect(responder).toHaveAttribute('aria-busy', 'false')
    await page.getByLabel('Sua resposta').fill(answer)
    await expect(responder).toBeEnabled()
    await responder.click()
  }
}

/** As três respostas usadas pela suíte inteira, para a jornada ser a mesma. */
export const INTAKE_ANSWERS = ['Clientes locais', 'Conhecer os serviços', 'Serviços e contato'] as const
