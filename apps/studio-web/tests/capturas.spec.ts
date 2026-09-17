import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { INTAKE_ANSWERS, answerIntake } from './answering'
import { abrirDetalhamento, esperarResultado, fecharDetalhamento } from './resultado'

/**
 * As CAPTURAS da entrega visual, tiradas do build que acompanha o commit.
 *
 * Existe porque a decisão de produto exige prova da versão nova e proíbe
 * reaproveitar captura antiga: "NUNCA reutilize screenshots antigas como prova
 * da versão nova". Um arquivo de teste é o jeito de a captura sair sempre do
 * mesmo servidor de teste que a suíte usa, no mesmo commit, sem ninguém
 * lembrar de rodar um passo à parte.
 *
 * O QUE ESTA PROVA É: interface real, servida pelo build, conversando com o
 * servidor de teste. O modelo é DUBLÊ — o construtor de fixture responde no
 * lugar do provedor. Isto é prova de interface e de integração com o servidor
 * de teste; NÃO é prova de geração com IA real nem do perfil Cordis, que
 * continuam em colunas próprias e bloqueadas neste ambiente.
 */
const PASTA = 'capturas'
const VIEWPORT = { width: 1280, height: 800 }

test('captura a jornada: home → tarefa → resultado → continuação', async ({ context, page }, testInfo) => {
  test.setTimeout(180_000)
  await mkdir(PASTA, { recursive: true })
  await page.setViewportSize(VIEWPORT)
  const origin = 'http://studio.dz23.localhost:4179'
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
  await context.addInitScript(() => { window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e') })

  const tirar = async (nome: string) => {
    await page.screenshot({ path: `${PASTA}/${nome}.png` })
    testInfo.annotations.push({ type: 'captura', description: `${nome}.png` })
  }

  await page.goto('/studio/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await tirar('01-home')

  await page.getByRole('button', { name: 'Página de apresentação' }).click()
  await page.getByRole('button', { name: 'Continuar' }).click()

  // ENVIAR ABRIU A CONVERSA: é a afirmação central da entrega. Sem ela, a
  // captura seguinte seria de um formulário com outra cor.
  await expect(page.getByLabel('Conversa desta tarefa')).toBeVisible()
  await tirar('02-conversa-inicio')

  await answerIntake(page, INTAKE_ANSWERS)
  await page.getByRole('button', { name: 'Montar meu plano' }).click()
  await expect(page.getByText('Plano proposto', { exact: false })).toBeVisible({ timeout: 20_000 })
  await tirar('03-conversa-plano')

  await page.getByRole('button', { name: 'Aprovar este plano' }).click()
  await page.getByRole('button', { name: 'Iniciar criação' }).click()
  await esperarResultado(page)
  await tirar('04-conversa-resultado')

  await abrirDetalhamento(page)
  await tirar('05-painel-detalhamento')
  await fecharDetalhamento(page)

  // CONTINUAR NA MESMA TAREFA. O endereço não pode mudar de projeto: é isso que
  // separa "continuar" de "começar outra vez".
  const projetoAntes = new URL(page.url()).searchParams.get('projeto')
  expect(projetoAntes).not.toBeNull()
  await page.getByLabel('Escreva aqui para continuar esta tarefa').fill('deixe o botão de contato em verde')
  await tirar('06-compositor-com-pedido')
  await page.getByRole('button', { name: 'Enviar' }).click()

  // O PEDIDO DA PESSOA vira mensagem dela na conversa. Sem isto, pedir uma
  // alteração sumia da tarefa e voltava só como um critério dentro do plano.
  await expect(page.getByLabel('Conversa desta tarefa').getByText('deixe o botão de contato em verde')).toBeVisible({ timeout: 20_000 })
  expect(new URL(page.url()).searchParams.get('projeto')).toBe(projetoAntes)
  // O histórico inteiro continua lá: o pedido original não foi embora.
  await expect(page.getByText(INTAKE_ANSWERS[0]!).first()).toBeVisible()
  await tirar('07-continuacao-na-mesma-tarefa')

  for (const [nome, caminho] of [
    ['08-habilidades', '/studio/habilidades'],
    ['09-plugins', '/studio/plugins'],
    ['10-biblioteca', '/studio/biblioteca'],
    ['11-agendado', '/studio/agendado'],
  ] as const) {
    await page.goto(caminho)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 20_000 })
    await tirar(nome)
  }

  // O celular é ADAPTAÇÃO DZ23, e não uma imagem fornecida pela referência:
  // o vídeo não demonstra versão móvel.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/studio/?projeto=${String(projetoAntes)}`)
  await expect(page.getByLabel('Conversa desta tarefa')).toBeVisible({ timeout: 20_000 })
  await tirar('12-conversa-celular')
})
