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
  /*
    MAPA DE EQUIVALÊNCIA — decisão `DZ23-VISUAL-VIDEO-20260916-R1`.

    | antes                                   | agora                                  |
    | --------------------------------------- | -------------------------------------- |
    | campo "Sua resposta" do cartão de perguntas | o COMPOSITOR inferior da conversa  |
    | botão "Responder e continuar"           | botão "Enviar" do compositor           |

    O cartão de perguntas era uma tela com título grande e caixa própria, e
    estava na lista do que o proprietário recusou. A pergunta agora é um lance
    da conversa e a resposta vai pelo mesmo compositor que continua a tarefa —
    que é a jornada única que a decisão pede. Este teste passou a exercitar
    esse caminho, que é o que a pessoa realmente usa.

    A espera continua sendo a mesma ideia, e continua existindo pelo mesmo
    motivo: o laço original digitava antes de a resposta anterior ser
    absorvida, e o texto ia embora com a troca de pergunta. Aqui o sinal é o
    botão "Enviar" desabilitado com `aria-busy="false"` — campo vazio e nada no
    ar —, que é o único estado em que a próxima resposta pode ser digitada sem
    corrida.
  */
  const enviar = page.getByRole('button', { name: 'Enviar' })
  const campo = page.getByLabel('Escreva aqui para continuar esta tarefa')
  for (const answer of answers) {
    await expect(enviar).toBeDisabled()
    await expect(enviar).toHaveAttribute('aria-busy', 'false')
    await campo.fill(answer)
    await expect(enviar).toBeEnabled()
    await enviar.click()
  }
}

/** As três respostas da admissão, iguais em todos os testes que a percorrem. */
export const INTAKE_ANSWERS = ['Clientes locais', 'Conhecer os serviços', 'Serviços e contato'] as const
