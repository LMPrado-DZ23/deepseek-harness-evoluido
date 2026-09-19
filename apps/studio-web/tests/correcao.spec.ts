import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

const origin = 'http://studio.dz23.localhost:4179'

/**
 * PLAN-01 no navegador: perguntar só o que falta e corrigir sem recomeçar.
 *
 * O pedido já diz o que o aplicativo deve fazer. Depois da primeira resposta,
 * a pergunta sobre isso NÃO é feita: a leitura aparece na conversa como
 * resposta recomendada, com a nota dizendo de onde ela veio. Com a
 * especificação pronta, a pessoa corrige essa resposta pela própria conversa,
 * e a conversa guarda as duas — a lida e a corrigida.
 */
test('o que o pedido já diz não é perguntado, e uma resposta se corrige pela conversa', async ({ context, page }) => {
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
  await context.addInitScript(() => { window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e') })
  await page.goto('/studio/')
  await page.getByRole('textbox').first().fill('Quero um site para os professores lançarem notas da turma')
  await page.getByRole('button', { name: 'Continuar' }).click()

  const enviar = page.getByRole('button', { name: 'Enviar' })
  const campo = page.getByLabel('Escreva aqui para continuar esta tarefa')
  await expect(page.getByText('Para quem você quer criar este projeto?').first()).toBeVisible()
  await campo.fill('Professores da escola')
  await enviar.click()

  // A pergunta sobre o objetivo foi PULADA: a próxima é a do conteúdo.
  await expect(page.getByText('Lançar e consultar as notas da turma')).toBeVisible()
  await expect(page.getByText('Recomendada pelo FRIGG — confira e corrija se não for isso')).toBeVisible()
  await expect(page.getByText('Quais informações ou itens precisam aparecer?').first()).toBeVisible()
  await expect(enviar).toHaveAttribute('aria-busy', 'false')
  await campo.fill('Nome da disciplina e a nota')
  await enviar.click()
  await expect(page.getByRole('button', { name: 'Montar meu plano' })).toBeVisible()

  // Corrigir a resposta lida: o campo vem com ela, para editar e não redigitar.
  await page.getByRole('button', { name: 'Corrigir resposta: O que a pessoa deve conseguir fazer ou entender?' }).click()
  await expect(campo).toHaveValue('Lançar e consultar as notas da turma')
  await expect(page.getByText('Corrigindo a resposta de:')).toBeVisible()
  const correcao = page.waitForResponse(resposta => resposta.url().endsWith('/intake/correct'))
  await campo.fill('Consultar a média de cada disciplina')
  await enviar.click()
  expect((await correcao).status()).toBe(201)
  await expect(page.getByText('Consultar a média de cada disciplina')).toBeVisible()
  // O histórico fica: a resposta lida continua na conversa, e a correção só vale para a última.
  await expect(page.getByText('Lançar e consultar as notas da turma')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Corrigir resposta: O que a pessoa/ })).toHaveCount(1)
  await expect(page.getByText('Corrigindo a resposta de:')).toHaveCount(0)

  const axe = await new AxeBuilder({ page }).analyze()
  expect(axe.violations).toEqual([])

  // Depois do plano, corrigir sai de cena: o caminho ali é o pedido de mudança.
  await page.getByRole('button', { name: 'Montar meu plano' }).click()
  await expect(page.getByRole('button', { name: 'Aprovar este plano' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Corrigir resposta/ })).toHaveCount(0)
})
