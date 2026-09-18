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
/*
  ONDE A CAPTURA CAI — e por que isso virou um defeito de CI.

  As capturas são ENTREGA: elas acompanham o commit e são a prova da versão
  nova. Por isso `capturas/` é versionado. Só que a CI roda esta mesma suíte, e
  o passo final dela — "Refuse unexpected build mutations" — reprova quando a
  árvore muda sozinha. Um PNG é diferente a cada execução (antialiasing,
  cursor, um pixel de fonte), então rodar o teste na CI reescrevia arquivos
  versionados e a CI reprovava com razão.

  A saída não é parar de capturar nem desligar o passo que protege a árvore. É
  dizer QUANDO a captura é entrega: com `DZ23_CAPTURAS=sim`, que é o que se usa
  ao preparar a entrega. Sem a variável — que é o caso da CI —, a jornada roda
  inteira e a captura cai na pasta de resultados do Playwright, que não é
  versionada. A prova de percurso continua; a mutação da árvore acaba.
*/
const ENTREGA = process.env.DZ23_CAPTURAS === 'sim'
const PASTA = ENTREGA ? 'capturas' : undefined
const VIEWPORT = { width: 1280, height: 800 }

test('captura a jornada: home → tarefa → resultado → continuação', async ({ context, page }, testInfo) => {
  test.setTimeout(180_000)
  if (PASTA !== undefined) await mkdir(PASTA, { recursive: true })
  await page.setViewportSize(VIEWPORT)
  const origin = 'http://studio.dz23.localhost:4179'
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
  await context.addInitScript(() => { window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e') })

  const tirar = async (nome: string) => {
    // `testInfo.outputPath` é a pasta de resultados DESTA execução, e ela não é
    // versionada: sem `DZ23_CAPTURAS=sim` a captura sai de lá e a árvore fica
    // como estava.
    await page.screenshot({ path: PASTA === undefined ? testInfo.outputPath(`${nome}.png`) : `${PASTA}/${nome}.png` })
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

  // As PREFERÊNCIAS (F04/F05), que a decisão visual pede na gravação. Duas
  // capturas de propósito: uma seção que funciona e uma que declara pendência —
  // a segunda é a que prova que não há botão mudo.
  await page.goto('/studio/')
  await page.getByRole('button', { name: 'Preferências', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Preferências' })).toBeVisible()
  await tirar('13-preferencias-conta')
  // O USO E CUSTOS, que deixou de ser pendência: a captura mostra rota medida
  // com custo real, rota sem preço dizendo "não medido", e a limitação escrita.
  await page.getByRole('dialog', { name: 'Preferências' }).getByRole('button', { name: 'Uso e custos', exact: true }).click()
  await expect(page.getByText('Cota de assinatura', { exact: false })).toBeVisible()
  await tirar('18-preferencias-uso')
  await page.getByRole('dialog', { name: 'Preferências' }).getByRole('button', { name: 'Tema', exact: true }).click()
  await expect(page.getByText('Ainda não disponível')).toBeVisible()
  await tirar('14-preferencias-pendencia')
  await page.keyboard.press('Escape')

  // O MODO EMPRESA (BUS-01). Duas capturas: o cadastro em branco e a empresa
  // gravada com a versão do plano — a segunda é a que mostra que a jornada
  // FECHA, e não só que o formulário desenha.
  await page.setViewportSize(VIEWPORT)
  // A captura é ENTREGA: ela tem de mostrar a tela da empresa recém-cadastrada,
  // e não uma lista com o que outros casos deixaram para trás.
  await page.request.get('http://127.0.0.1:4179/e2e/reset-business')
  await page.goto('/studio/empresas')
  await page.getByRole('button', { name: 'Cadastrar empresa' }).click()
  await expect(page.getByRole('button', { name: 'Salvar empresa' })).toBeDisabled()
  await tirar('15-empresa-cadastro')
  await page.getByLabel('Nome da empresa').fill('Bolos da Ana')
  await page.getByLabel('O que a empresa se propõe a fazer').fill('vender bolos caseiros por encomenda no bairro')
  await page.getByLabel('Para quem').fill('moradores do bairro')
  await page.getByLabel('O que ela entrega').fill('bolo de 1kg com 2 dias de antecedência')
  await page.getByLabel('O que ela não faz').fill('não entrega fora do bairro')
  await page.getByRole('button', { name: 'Salvar empresa' }).click()
  await expect(page.getByRole('heading', { level: 3, name: 'Versão 1 do plano' })).toBeVisible()
  await tirar('16-empresa-plano')
  // A TAREFA que nasce da empresa (BUS-02): a captura mostra o vínculo com a
  // versão do plano, que é o que faz a tarefa saber de onde veio.
  await page.getByRole('button', { name: 'Criar uma tarefa para esta empresa' }).click()
  await page.getByLabel('O que você quer que seja criado').fill('uma página para receber encomendas do bairro')
  await page.getByRole('button', { name: 'Criar a tarefa' }).click()
  await expect(page.getByLabel('Tarefas desta empresa').getByRole('link', { name: 'uma página para receber encomendas do bairro' })).toBeVisible()
  await tirar('17-empresa-tarefa')

  // O celular é ADAPTAÇÃO FRIGG, e não uma imagem fornecida pela referência:
  // o vídeo não demonstra versão móvel.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/studio/?projeto=${String(projetoAntes)}`)
  await expect(page.getByLabel('Conversa desta tarefa')).toBeVisible({ timeout: 20_000 })
  await tirar('12-conversa-celular')
})
