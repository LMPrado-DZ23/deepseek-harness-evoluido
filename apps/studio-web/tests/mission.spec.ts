import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const origin = 'http://studio.dz23.localhost:4179'

/**
 * Devolve o objetivo de prova ao estado inicial.
 *
 * Sem isto, o teste que marca como terminado deixaria os outros tamanhos de
 * tela sem o botão — e eles reprovariam pela ORDEM em que rodaram, e não por um
 * defeito.
 */
async function reset(page: import('@playwright/test').Page): Promise<void> {
  await page.request.get('http://127.0.0.1:4179/e2e/reset-mission')
}

async function signedIn(context: import('@playwright/test').BrowserContext): Promise<void> {
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
  await context.addInitScript(() => { window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e') })
}

/**
 * O objetivo reúne vários trabalhos sob a mesma meta e carrega a lista do que
 * precisa estar comprovado antes de ser dado por encerrado.
 *
 * O que este teste protege é a distinção que mais se perde: "ainda sem prova" e
 * "parado por alguém de fora" são coisas DIFERENTES. Uma pede trabalho, a outra
 * pede outra pessoa — e juntá-las num "pendente" manda quem lê a tela tentar a
 * coisa errada.
 */
test('a tela mostra o que falta, e separa falta de trabalho de falta de gente', async ({ context, page }) => {
  await signedIn(context)
  await reset(page)
  await page.goto('/studio/objetivos')
  await expect(page.getByRole('heading', { name: 'Objetivos', level: 1 })).toBeVisible()
  await expect(page.getByText('Colocar o site no ar para os clientes')).toBeVisible()

  // As duas situações aparecem EM PORTUGUÊS, e são frases distintas. Um código
  // de máquina aqui mandaria a pessoa perguntar a alguém o que significa.
  // O estado do ITEM, e não qualquer texto igual na página: as opções do
  // seletor de registro repetem essas mesmas frases, que é o certo — elas são a
  // mesma coisa dita nos dois lugares.
  const estados = page.locator('.mission-criterion-state')
  await expect(estados.filter({ hasText: 'Comprovado' })).toHaveCount(1)
  await expect(estados.filter({ hasText: 'Parado por alguém de fora' })).toHaveCount(1)
  await expect(page.locator('body')).not.toContainText('BLOCKED_EXTERNAL')
  await expect(page.locator('body')).not.toContainText('UNPROVEN')

  // Quem está esperando alguém de fora vê DE QUEM depende.
  await expect(page.getByText('a empresa que registra o endereço')).toBeVisible()
  // E quem já provou vê ONDE está a prova: um item que se diz comprovado sem
  // mostrar a prova é a mesma coisa que não estar comprovado.
  await expect(page.getByText('Teste de envio gravado em 08/09')).toBeVisible()
})

/**
 * Marcar como terminado e encerrar são gestos DIFERENTES, e a tela não os
 * mistura: o primeiro é a pessoa dizendo que acredita ter acabado, o segundo é
 * a conferência item a item — que aqui recusa, porque um item está parado.
 */
test('marcar como terminado não encerra: o encerramento confere e recusa, dizendo o que falta', async ({ context, page }) => {
  await signedIn(context)
  await reset(page)
  await page.goto('/studio/objetivos')
  await page.getByRole('heading', { name: 'Objetivos', level: 1 }).waitFor()

  await page.getByRole('button', { name: 'Marcar como terminado' }).click()
  await expect(page.getByText('Marcado como terminado, aguardando conferência')).toBeVisible()

  // Agora o outro gesto aparece — e ele NÃO some por causa do item parado:
  // esconder o botão trocaria uma recusa explicada por um botão que sumiu sem
  // motivo visível.
  const encerrar = page.getByRole('button', { name: 'Encerrar objetivo' })
  await expect(encerrar).toBeVisible()
  await encerrar.click()

  // A recusa do servidor chega inteira à tela: é nela que está o que falta.
  const aviso = page.getByRole('alert')
  await expect(aviso).toBeVisible()
  await expect(aviso).toContainText('dominio')
})

test('"Objetivos" é um link de verdade na navegação, e leva à tela', async ({ context, page }) => {
  await signedIn(context)
  await page.goto('/studio/')
  // Abaixo de 1024px o trilho vira gaveta e o botão do menu é a ÚNICA porta —
  // é por isso que este teste roda nos quatro tamanhos, e não só no de mesa.
  if ((page.viewportSize()?.width ?? 1280) <= 1024) {
    await page.getByRole('button', { name: 'Abrir o menu', exact: true }).click()
  }
  const item = page.getByRole('navigation').getByRole('link', { name: 'Objetivos' })
  await expect(item).toBeVisible()
  await item.click()
  await expect(page).toHaveURL(/\/studio\/objetivos$/u)
})

test('a tela de objetivos não tem violação de acessibilidade', async ({ context, page }) => {
  await signedIn(context)
  await reset(page)
  await page.goto('/studio/objetivos')
  await page.getByRole('heading', { name: 'Objetivos', level: 1 }).waitFor()
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})

test('no escuro, a tela de objetivos continua legível', async ({ browser }) => {
  // O modo escuro já produziu texto branco sobre fundo branco uma vez. Tela
  // nova entra na varredura, e não depois.
  const context = await browser.newContext({ colorScheme: 'dark' })
  await signedIn(context)
  const page = await context.newPage()
  await reset(page)
  await page.goto('/studio/objetivos')
  await page.getByRole('heading', { name: 'Objetivos', level: 1 }).waitFor()
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
  await context.close()
})

/**
 * Criar um objetivo é a porta de entrada da tela — e até aqui ela não existia:
 * a mensagem de lista vazia dizia que "um objetivo é criado junto com o
 * trabalho que ele reúne", o que era uma forma educada de dizer que a pessoa
 * não podia criar nenhum.
 *
 * O que este teste protege é o gesto INTEIRO, incluindo a recusa: quem escolhe
 * o identificador técnico é a tela, derivando da frase, e o servidor é quem diz
 * a última palavra sobre repetido.
 */
test('dá para criar um objetivo escrevendo a meta e o que precisa estar comprovado', async ({ context, page }) => {
  await signedIn(context)
  await reset(page)
  await page.goto('/studio/objetivos')
  await expect(page.getByRole('heading', { name: 'Criar um objetivo' })).toBeVisible()

  // O identificador técnico não é pedido: quem escreve uma meta não deve
  // precisar inventar uma chave de banco de dados.
  await expect(page.getByLabel('Qual é a meta')).toBeVisible()
  await page.getByLabel('Qual é a meta').fill('Aceitar pagamento no site')
  await page.getByLabel('O que precisa estar comprovado 1').fill('O pagamento de teste cai na conta')
  await page.getByRole('button', { name: 'Adicionar mais um item' }).click()
  await page.getByLabel('O que precisa estar comprovado 2').fill('O recibo chega por e-mail')
  await page.getByLabel('Limite de consumo (opcional)').fill('2000')
  await page.getByRole('button', { name: 'Criar objetivo' }).click()

  // O objetivo novo aparece na lista, com os dois itens e ainda sem prova.
  await expect(page.getByText('Aceitar pagamento no site')).toBeVisible()
  await expect(page.getByText('O pagamento de teste cai na conta')).toBeVisible()
  await expect(page.getByText('O recibo chega por e-mail')).toBeVisible()
  // E o objetivo que já existia continua lá: criar não substitui a lista.
  await expect(page.getByText('Colocar o site no ar para os clientes')).toBeVisible()

  // O formulário se esvazia depois de criar: deixar o texto lá convida a pessoa
  // a clicar de novo achando que não funcionou.
  await expect(page.getByLabel('Qual é a meta')).toHaveValue('')
})

test('a recusa do formulário diz o que falta, e a do servidor chega como veio', async ({ context, page }) => {
  await signedIn(context)
  await reset(page)
  await page.goto('/studio/objetivos')
  await expect(page.getByRole('heading', { name: 'Criar um objetivo' })).toBeVisible()

  // Meta curta: recusado ANTES da ida de rede, com a frase do problema certo.
  await page.getByLabel('Qual é a meta').fill('ab')
  await page.getByRole('button', { name: 'Criar objetivo' }).click()
  await expect(page.getByRole('alert')).toContainText('pelo menos três letras')

  // Meta boa, mas sem nenhum item: outra frase, e não a mesma.
  await page.getByLabel('Qual é a meta').fill('Uma meta bem escrita')
  await page.getByRole('button', { name: 'Criar objetivo' }).click()
  await expect(page.getByRole('alert')).toContainText('pelo menos um item')

  // Agora a recusa do SERVIDOR. Ela só é alcançável quando o objetivo existe
  // SEM a tela saber — outra pessoa, ou outra aba, criando a mesma coisa. É por
  // isso que o desempate do lado da tela é cortesia e não garantia: aqui ele
  // não tem como ajudar, porque não há nada na lista carregada com que colidir.
  await page.request.get('http://127.0.0.1:4179/e2e/plant-mission?id=uma-meta-criada-por-outra-pessoa')
  await page.getByLabel('Qual é a meta').fill('Uma meta criada por outra pessoa')
  await page.getByLabel('O que precisa estar comprovado 1').fill('Algo que precisa ser comprovado')
  await page.getByRole('button', { name: 'Criar objetivo' }).click()
  // A frase é a do SERVIDOR, e não uma genérica da tela: é ela que sabe o que
  // aconteceu, e trocá-la apagaria justamente isso.
  await expect(page.getByRole('alert')).toContainText('Já existe um objetivo com esta mesma meta')
})

/**
 * Registrar a prova PELA TELA fecha o último pedaço do `T-14`: a rota existia,
 * era testada, e nada na interface a chamava — então na prática ninguém podia
 * comprovar um item sem chamar a API na mão.
 *
 * O que este teste protege é o ciclo INTEIRO, e em especial a recusa: encerrar
 * com um item parado por alguém de fora não é encerrar.
 */
test('dá para registrar a prova de um item e só então encerrar o objetivo', async ({ context, page }) => {
  await signedIn(context)
  await reset(page)
  await page.goto('/studio/objetivos')
  await expect(page.getByText('Colocar o site no ar para os clientes')).toBeVisible()

  // O item parado por alguém de fora: o editor dele nasce no estado ATUAL, com
  // o motivo já preenchido. Nascer em "ainda sem prova" faria um clique
  // distraído apagar o que já estava registrado.
  const parado = page.locator('li', { hasText: 'O endereço do site aponta para a hospedagem' })
  await expect(parado.getByLabel('De quem ou de quê depende'))
    .toHaveValue('a empresa que registra o endereço')

  // Marcar como terminado e tentar encerrar: recusa, porque o item está parado.
  await page.getByRole('button', { name: 'Marcar como terminado' }).click()
  await page.getByRole('button', { name: 'Encerrar objetivo' }).click()
  await expect(page.getByRole('alert').first()).toContainText('depende de alguém de fora')

  // Agora a prova chega. O campo TROCA junto com o estado: escolher
  // "Comprovado" tira o campo de motivo e põe o de prova.
  await parado.getByLabel('Em que pé está').selectOption('PROVEN')
  await expect(parado.getByLabel('De quem ou de quê depende')).toHaveCount(0)
  await parado.getByLabel('Onde está a prova').fill('Apontamento conferido em 09/09')
  await parado.getByRole('button', { name: 'Registrar' }).click()

  // A prova aparece na lista, e o motivo antigo SOME: um item comprovado que
  // ainda mostra de quem dependia conta duas histórias ao mesmo tempo.
  await expect(page.getByText('Onde está a prova: Apontamento conferido em 09/09')).toBeVisible()
  await expect(page.getByText('Depende de: a empresa que registra o endereço')).toHaveCount(0)

  // Mexer no item desfez a candidatura, então é preciso marcar de novo — e aí
  // o encerramento passa.
  await page.getByRole('button', { name: 'Marcar como terminado' }).click()
  await page.getByRole('button', { name: 'Encerrar objetivo' }).click()
  await expect(page.locator('.mission-status')).toHaveText('Encerrado')

  // Encerrado, não há mais o que registrar: o servidor recusaria, e um campo
  // que existe para ser recusado é pior do que um campo que não existe.
  await expect(page.getByRole('button', { name: 'Registrar' })).toHaveCount(0)
})

test('comprovar sem dizer onde está a prova é recusado, com a frase do campo certo', async ({ context, page }) => {
  await signedIn(context)
  await reset(page)
  await page.goto('/studio/objetivos')
  const item = page.locator('li', { hasText: 'O endereço do site aponta para a hospedagem' })
  await item.getByLabel('Em que pé está').selectOption('PROVEN')
  await item.getByLabel('Onde está a prova').fill('   ')
  await item.getByRole('button', { name: 'Registrar' }).click()
  await expect(item.getByRole('alert')).toContainText('onde está a prova')
})
