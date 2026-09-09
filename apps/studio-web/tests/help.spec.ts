import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const origin = 'http://studio.dz23.localhost:4179'

/**
 * O produto é para quem não programa e usa vocabulário próprio o tempo todo.
 * O ícone de ajuda existia e estava DESLIGADO: não havia, em lugar nenhum do
 * aplicativo, onde descobrir o que "protótipo", "prévia local" ou "ponto
 * seguro" querem dizer.
 */
test('a ajuda abre pela barra de navegação e explica o vocabulário do produto', async ({ context, page }) => {
  await context.addCookies([{ name: 'dz23_studio_session', value: 'e2e', url: origin }])
  await page.goto('/studio/')
  await page.getByRole('link', { name: 'Ajuda' }).click()
  await expect(page.getByRole('heading', { name: 'Ajuda do DZ23 STUDIO' })).toBeVisible()
  // As palavras que a interface usa e ninguém explicava.
  for (const term of ['Protótipo', 'Prévia local', 'Ponto seguro', 'Ambiente isolado', 'Perfil de privacidade', 'Limite de gasto']) {
    await expect(page.getByRole('definition').filter({ hasText: '' }).first()).toBeVisible()
    await expect(page.getByText(term, { exact: true }).first()).toBeVisible()
  }
  // E a ajuda não pode contradizer o resto do produto.
  await expect(page.getByText('Não publica seu aplicativo na internet.', { exact: false })).toBeVisible()
  await expect(page.getByText(/\bpront[oa]s?\b/iu)).toHaveCount(0)
  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])
  await page.getByRole('link', { name: 'Voltar ao início' }).click()
  await expect(page.getByRole('heading', { name: 'Vamos criar seu aplicativo' })).toBeVisible()
})

/**
 * A tela diz de ONDE veio o tipo — e não afirma o que não sabe.
 *
 * Com dois estados só, quem escrevia "sistema pra barbearia" via o seletor já
 * em "Agenda de horários" E a frase "não deu para entender o tipo pelo seu
 * texto". Duas afirmações que se contradizem na mesma tela, e nenhuma delas
 * explicando de onde veio a agenda. São quatro estados agora, e este teste
 * afirma três deles no navegador.
 */
test('o tipo mostrado vem com a frase que explica de onde ele veio', async ({ context, page }) => {
  await context.addCookies([{ name: 'dz23_studio_session', value: 'e2e', url: 'http://studio.dz23.localhost:4179' }])
  await page.goto('/studio/')
  const brief = page.getByRole('textbox').first()
  const kind = page.getByLabel('Tipo de aplicativo')

  // 1. Só o RAMO: escolhe agenda, e NÃO diz que entendeu o pedido.
  await brief.fill('sistema pra barbearia')
  await expect(kind).toHaveValue('scheduling')
  await expect(page.getByText('Reconhecemos só o seu ramo')).toBeVisible()

  // 2. O TEXTO diz o que o aplicativo faz.
  await brief.fill('quero uma agenda para minha clínica marcar consultas')
  await expect(kind).toHaveValue('scheduling')
  await expect(page.getByText('Entendemos isto pelo seu texto')).toBeVisible()

  // 3. A PESSOA escolheu: a tela para de dizer que entendeu pelo texto.
  await kind.selectOption('catalog')
  await expect(page.getByText('Você escolheu este tipo')).toBeVisible()
})
