import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { INTAKE_ANSWERS, answerIntake } from './answering'
import { abrirDetalhamento, esperarResultado, fecharDetalhamento } from './resultado'

const origin = 'http://studio.dz23.localhost:4179'

/**
 * O axe varria TRÊS telas do produto.
 *
 * A gaveta de navegação (só abaixo de 1024px), o painel de equipe e a tela do
 * plano — esta última só no tamanho de mesa e com o viewport forçado a 390px.
 * Ficavam de fora, em todo tamanho: a tela da Ideia (campo de texto, sete
 * sugestões, quatro cartões de aparência, o `fieldset` de privacidade e agora o
 * seletor de tipo), a tela de Perguntas e a tela de Verificação com a lista de
 * conferências. São as telas por onde TODA pessoa passa.
 *
 * Este arquivo varre o caminho inteiro, e roda nos três tamanhos.
 */
test.use({ serviceWorkers: 'block' })

test.describe('acessibilidade do fluxo principal', () => {
  test.beforeEach(async ({ context, page }) => {
    await context.addCookies([
      { name: 'dz23_studio_session', value: 'e2e', url: origin },
      { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
    ])
    await context.addInitScript(() => { window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e') })
  })

  test('a ideia, as perguntas, o plano e a verificação passam no axe', async ({ page }, testInfo) => {
    const violations: string[] = []
    const check = async (screen: string) => {
      const result = await new AxeBuilder({ page }).analyze()
      for (const violation of result.violations) {
        violations.push(`${testInfo.project.name}/${screen}: ${violation.id} (${violation.nodes.length}) ${violation.nodes[0]?.html ?? ''}`)
      }
    }

    await page.goto('/studio/')
    await expect(page.getByRole('heading', { name: 'O que posso fazer por você?' })).toBeVisible()
    await check('ideia')

    // O seletor de tipo é novo nesta tela e nunca tinha sido varrido. O texto é
    // o da sugestão porque o servidor de teste responde a este caminho — o que
    // está sob varredura aqui é a TELA, não o que o gerador faz com o texto.
    await page.getByRole('button', { name: 'Página de apresentação' }).click()
    await check('ideia-preenchida')

    await page.getByRole('button', { name: 'Continuar' }).click()
    /*
      MAPA DE EQUIVALÊNCIA: o título "Só mais alguns detalhes" era o herói do
      CARTÃO DE PERGUNTAS — uma tela própria, com caixa e título grandes, que a
      decisão de produto listou entre o que não pode voltar. A garantia que ele
      carregava era "enviar levou a pessoa adiante"; agora ela é afirmada pelo
      que de fato acontece: a CONVERSA abre, e a pergunta é um lance dela.
    */
    await expect(page.getByLabel('Conversa desta tarefa')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Para quem você quer criar este projeto?')).toBeVisible()
    await check('perguntas')

    await answerIntake(page, INTAKE_ANSWERS)
    await page.getByRole('button', { name: 'Montar meu plano' }).click()
    await expect(page.locator('.plan-list .task-card').first()).toBeVisible({ timeout: 15_000 })
    await check('plano')

    await page.getByRole('button', { name: 'Aprovar este plano' }).click()
    await expect(page.getByRole('button', { name: 'Iniciar criação' })).toBeVisible()
    await check('criacao')

    await page.getByRole('button', { name: 'Iniciar criação' }).click()
    // O resultado chega na CONVERSA; o detalhamento continua inteiro, atrás do
    // painel. `tests/resultado.ts` tem o mapa de equivalência.
    await esperarResultado(page)
    await check('conversa')
    await abrirDetalhamento(page)
    await check('detalhamento')
    await fecharDetalhamento(page)

    expect(violations, violations.join('\n')).toEqual([])
  })

  test('as Preferências abrem, passam no axe e NÃO oferecem controle do que não existe', async ({ page }) => {
    /*
      A decisão do proprietário proíbe botão mudo por escrito. O quadro F04 da
      referência mostra treze itens; aqui os que ainda não existem aparecem
      como TEXTO dizendo o que falta — e este teste confere no navegador que
      não há controle interativo dentro de uma seção indisponível.
    */
    await page.goto('/studio/')
    // Abaixo de 1024px o trilho sai do fluxo, e a conta mora no rodapé DELE: a
    // porta é o botão de menu. Sem isto, este teste provava as Preferências só
    // na mesa — e a referência é a mesma experiência adaptada, não outra.
    const menu = page.getByRole('button', { name: 'Abrir o menu', exact: true })
    if (await menu.isVisible()) await menu.click()
    await page.getByRole('button', { name: 'Preferências', exact: true }).click()
    const modal = page.getByRole('dialog', { name: 'Preferências' })
    await expect(modal).toBeVisible()

    const semViolacao = await new AxeBuilder({ page }).analyze()
    expect(semViolacao.violations.map(violation => violation.id)).toEqual([])

    // Uma seção que não existe: só a frase, nenhum controle.
    await modal.getByRole('button', { name: 'Tema', exact: true }).click()
    await expect(modal.getByText('Ainda não disponível')).toBeVisible()
    const corpo = modal.locator('.dz-preferencias-corpo')
    // O botão de fechar é o único controle do corpo nessa seção.
    await expect(corpo.locator('button, a, input, select, textarea')).toHaveCount(1)

    // Uma capacidade que EXISTE leva ao destino real, e não a "#".
    await modal.getByRole('button', { name: 'Habilidades', exact: true }).click()
    await expect(corpo.getByRole('link', { name: 'Abrir' })).toHaveAttribute('href', '/studio/habilidades')

    // Esc fecha, e a tarefa e o rascunho continuam onde estavam.
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()
  })

  test('as Preferências mostram o consumo do espaço, sem transformar ausência em zero', async ({ page }) => {
    /*
      A seção "Uso e custos" era uma PENDÊNCIA que dizia "a medição ainda
      não foi construída" — e a verificação do T-35 provou que a frase estava
      errada. O que faltava era a apresentação fora da tarefa.

      O que este caso guarda é a regra do adendo na camada que a pessoa lê:
      rota sem preço aparece como NÃO MEDIDA, e rota medida com custo zero
      continua zero.
    */
    await page.goto('/studio/')
    // Abaixo de 1024px o trilho sai do fluxo e a porta é o botão de menu — o
    // mesmo caminho do caso das Preferências acima. Sem isto, este teste
    // provava a seção só na mesa.
    const menu = page.getByRole('button', { name: 'Abrir o menu', exact: true })
    if (await menu.isVisible()) await menu.click()
    await page.getByRole('button', { name: 'Preferências', exact: true }).click()
    const modal = page.getByRole('dialog', { name: 'Preferências' })
    await modal.getByRole('button', { name: 'Uso e custos', exact: true }).click()

    // A rota medida de graça continua zero; a sem preço diz que não sabe.
    await expect(modal.getByRole('row', { name: /ollama/u })).toContainText('US$ 0,0000')
    await expect(modal.getByRole('row', { name: /deepseek-official/u })).toContainText('não medido')
    // E o total diz o que ficou de fora dele.
    await expect(modal.getByText('1 chamada(s) sem preço configurado', { exact: false })).toBeVisible()
    // A limitação do produto está escrita, e não subentendida.
    await expect(modal.getByText('Cota de assinatura e custo informado pelo provedor não existem', { exact: false })).toBeVisible()

    const semViolacao = await new AxeBuilder({ page }).analyze()
    expect(semViolacao.violations.map(violation => violation.id)).toEqual([])
  })

  test('os menus do compositor abrem com o que ESTE Studio tem ligado', async ({ page }) => {
    /*
      F08/F09 mostram os menus ancorados no compositor. O da referência lista as
      contas dela; aqui a lista é a do Hub deste Studio — e quando não há
      nenhuma, o menu DIZ isso em vez de mostrar serviços que ninguém conectou.
    */
    await page.goto('/studio/')
    const botao = page.getByRole('button', { name: 'Habilidades deste envio' })
    await expect(botao).toHaveAttribute('aria-expanded', 'false')
    await botao.click()
    await expect(botao).toHaveAttribute('aria-expanded', 'true')
    const caixa = page.getByRole('group', { name: 'Habilidades deste envio' })
    await expect(caixa).toBeVisible()
    // Administrar é no destino real, e não numa segunda cópia da tela aqui.
    await expect(caixa.getByRole('link', { name: 'Gerenciar' })).toHaveAttribute('href', '/studio/habilidades')

    const semViolacao = await new AxeBuilder({ page }).analyze()
    expect(semViolacao.violations.map(violation => violation.id)).toEqual([])

    await page.keyboard.press('Escape')
    await expect(caixa).toBeHidden()
  })

  test('o painel de uso e custos diz o que NÃO foi registrado', async ({ page }) => {
    /*
      O adendo do proprietário proíbe por escrito que uso desconhecido vire
      zero. A tarefa deste servidor de teste roda com construtor dublê, que não
      grava consumo: é exatamente o caso em que um painel mal feito mostraria
      "US$ 0,00" e a pessoa acreditaria.
    */
    await page.goto('/studio/')
    await page.getByRole('button', { name: 'Página de apresentação' }).click()
    await page.getByRole('button', { name: 'Continuar' }).click()
    await answerIntake(page, INTAKE_ANSWERS)
    await page.getByRole('button', { name: 'Montar meu plano' }).click()
    await expect(page.getByText('Plano proposto', { exact: false })).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: 'Aprovar este plano' }).click()
    await page.getByRole('button', { name: 'Iniciar criação' }).click()
    await esperarResultado(page)

    await page.getByRole('button', { name: 'Ver uso e custos' }).click()
    const painel = page.getByLabel('Painel desta tarefa')
    await expect(painel.getByText('não registrado').first()).toBeVisible()
    await expect(painel.getByText('US$ 0.0000')).toHaveCount(0)

    const semViolacao = await new AxeBuilder({ page }).analyze()
    expect(semViolacao.violations.map(violation => violation.id)).toEqual([])
  })

  test('a Biblioteca DECLARA o que guarda e o que faz', async ({ page }) => {
    // Exigência do proprietário, por escrito. Uma tela que lista pacotes e não
    // diz o que ela é deixa quem usa supondo que dá para subir arquivo,
    // versionar e compartilhar — e a pessoa só descobre quando precisa.
    await page.goto('/studio/biblioteca')
    // Ela é RECOLHIDA: no quadro F14 o acervo começa logo abaixo do título, e a
    // primeira coisa que a pessoa via era a lista do que o produto NÃO faz.
    // Continua obrigatória e a um clique — e este teste é o clique.
    const abrirDeclaracao = page.locator('#dz-biblioteca-declaracao-titulo')
    await abrirDeclaracao.click()
    const declaracao = page.locator('.dz-biblioteca-declaracao')
    await expect(declaracao).toContainText('.zip')
    // As duas respostas, e não só a boa.
    await expect(declaracao.getByRole('heading', { name: 'Ela faz', exact: true })).toBeVisible()
    await expect(declaracao.getByRole('heading', { name: 'Ela ainda NÃO faz' })).toBeVisible()
    // E cada "não" com o motivo.
    await expect(declaracao).toContainText('Não existe envio de arquivo neste produto')

    const semViolacao = await new AxeBuilder({ page }).analyze()
    expect(semViolacao.violations.map(violation => violation.id)).toEqual([])
  })

  test('a Biblioteca NUMERA as versões de uma tarefa e diz o que mudou', async ({ page }) => {
    /*
      A segunda das seis operações que a declaração dizia faltar. Como a prévia,
      ela foi escolhida por PRÉ-REQUISITO: o motor já estava gravado — cada
      pacote carrega tentativa, resumo criptográfico e instante —, então
      versionar é derivar, e não guardar de novo.
    */
    await page.goto('/studio/biblioteca')
    /*
      A busca é ESCOPADA ao primeiro grupo porque o acervo tem mais de uma
      tarefa, e cada uma numera as SUAS versões a partir de 1 — que é o certo:
      "a versão 2" é uma frase sobre uma tarefa, e não sobre a Biblioteca
      inteira. Sem o escopo, o caso quebraria por ambiguidade e me faria
      "consertar" uma numeração que está correta.
    */
    /*
      A DECLARAÇÃO e o COMPORTAMENTO conferidos na mesma visita.

      A declaração da Biblioteca diz o que ela faz, e ela é lida como promessa.
      Sem esta amarra, o texto podia continuar dizendo "versões: não" enquanto a
      tela versionava — ou o contrário, que é pior.
    */
    await page.locator('#dz-biblioteca-declaracao-titulo').click()
    await expect(page.locator('.dz-biblioteca-declaracao')).toContainText('numerar as versões')

    const grupo = page.locator('.dz-acervo-grupo').first()
    // A versão 1 é a MAIS ANTIGA e continua sendo a versão 1 amanhã; a leitura
    // é da mais nova para a mais antiga.
    await expect(grupo.getByText('Versão 2', { exact: true })).toBeVisible()
    await expect(grupo.getByText('Versão 1', { exact: true })).toBeVisible()
    await expect(grupo.getByText('mais recente', { exact: true })).toHaveCount(1)
    // E o que mudou de uma para a outra, em palavras.
    await expect(grupo.getByText('primeira versão desta tarefa')).toBeVisible()
    await expect(grupo.getByText('cresceu', { exact: false })).toBeVisible()
    await expect(grupo.getByText('conteúdos diferentes', { exact: false })).toBeVisible()
    // Nenhum marcador do catálogo vaza para a tela.
    await expect(page.getByText('{bytes}')).toHaveCount(0)
    await expect(page.getByText('{n}')).toHaveCount(0)

    const semViolacao = await new AxeBuilder({ page }).analyze()
    expect(semViolacao.violations.map(violation => violation.id)).toEqual([])
  })

  test('a Biblioteca abre o pacote e mostra o que tem dentro, sem baixar', async ({ page }) => {
    /*
      A operação que a declaração dizia que faltava. O `.zip` deste servidor de
      teste é montado pelo `createZip` de produção e lido pelo `listZip` de
      produção: o dublê é o armazenamento, e não o formato.
    */
    // A Biblioteca lista o acervo POR TAREFA: sem tarefa não há acervo, e a
    // tela diz isso. Então a tarefa vem primeiro — é o caminho do produto.
    await page.goto('/studio/')
    await page.getByRole('button', { name: 'Página de apresentação' }).click()
    await page.getByRole('button', { name: 'Continuar' }).click()
    await expect(page.getByLabel('Conversa desta tarefa')).toBeVisible({ timeout: 20_000 })

    /*
      O CONTADOR existe porque este trabalho encontrou um laço de requisições
      aqui. `api = createHubApi()` no valor padrão do parâmetro produzia um
      objeto novo a cada render; o efeito dependia dele e chamava `setAcervo`, e
      cada render disparava outra leitura. MEDIDO antes do conserto: 621
      chamadas a `/exports` em 3 segundos, numa tela parada. Depois: 1.

      A tela desenhava certo o tempo todo — o defeito só cobrava a conta do
      servidor, da bateria e da rede de quem deixasse a Biblioteca aberta. Por
      isso a guarda é uma CONTAGEM, e não uma captura.
    */
    let leituras = 0
    page.on('request', pedido => { if (pedido.url().includes('/exports')) leituras += 1 })

    await page.goto('/studio/biblioteca')
    // `.first()`: as tarefas criadas pelos tamanhos de tela anteriores
    // continuam no servidor de teste, e cada uma tem o pacote de exemplo. O
    // que este teste prova é a operação, e ela é a mesma em qualquer pacote.
    const abrir = page.getByRole('button', { name: 'Ver o que tem dentro' }).first()
    await expect(abrir).toBeVisible()
    await expect(abrir).toHaveAttribute('aria-expanded', 'false')
    await abrir.click()
    await expect(abrir).toHaveAttribute('aria-expanded', 'true')

    /*
      A contagem da PRÉVIA tem de bater com a que o cartão declara.

      Esta asserção era um número fixo e quebrou quando a tarefa passou a ter
      DUAS versões: o botão de cima virou o da versão 2, que tem quatro
      arquivos. O número fixo estava certo por acidente — o que interessa é que
      a prévia e o cartão digam a MESMA coisa sobre o mesmo pacote, porque duas
      contagens divergentes do mesmo arquivo são a segunda verdade de sempre.
    */
    const cartao = page.locator('.dz-acervo-item').first()
    const declarados = (await cartao.locator('.dz-acervo-fatos dd').nth(1).innerText()).trim()
    await expect(cartao.getByText(`${declarados} arquivo(s) neste pacote`)).toBeVisible()
    await expect(page.getByText('app/index.html').first()).toBeVisible()
    await expect(page.getByText('LEIA-ME.md').first()).toBeVisible()
    // O download continua ali do lado: a prévia não substituiu a operação que
    // já existia.
    // O nome do arquivo ENTRA no rótulo: ele já vazou como "Baixar {file}"
    // numa captura de entrega, porque nenhum teste olhava o texto do link.
    await expect(page.getByRole('link', { name: 'Baixar prototipo.zip' }).first()).toBeVisible()
    await expect(page.getByText('{file}')).toHaveCount(0)

    const semViolacao = await new AxeBuilder({ page }).analyze()
    expect(semViolacao.violations.map(violation => violation.id)).toEqual([])

    // E fecha — no MESMO botão, cujo nome não muda: o estado mora em
    // `aria-expanded`, que é o padrão ARIA de divulgação.
    await abrir.click()
    await expect(abrir).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByText('3 arquivo(s) neste pacote')).toHaveCount(0)

    // Uma leitura do acervo por tarefa, mais uma da prévia. Um número que
    // cresce com o tempo é o laço de volta.
    await page.waitForTimeout(1_000)
    // Uma leitura por tarefa existente, mais a prévia. O teto é generoso de
    // propósito: o que ele pega é a ORDEM DE GRANDEZA do laço, que media 621
    // em três segundos, e não o número exato de tarefas do servidor de teste.
    expect(leituras).toBeLessThan(40)
  })

  test('as Empresas passam no axe — vazia, formulário aberto, empresa gravada e tarefa criada', async ({ page }) => {
    /*
      As TRÊS formas da tela, e não só a que abre primeiro.

      Uma varredura só no estado vazio não veria nenhum campo de formulário nem
      o detalhe da empresa — que é justamente onde moram rótulo, foco e ordem de
      cabeçalho. O defeito que esta varredura procura não aparece numa tela sem
      conteúdo.
    */
    await page.request.get('http://127.0.0.1:4179/e2e/reset-business')
    await page.goto('/studio/empresas')
    await expect(page.getByRole('heading', { level: 1, name: 'Empresas' })).toBeVisible()
    const vazia = await new AxeBuilder({ page }).analyze()
    expect(vazia.violations.map(violation => violation.id)).toEqual([])

    await page.getByRole('button', { name: 'Cadastrar empresa' }).click()
    const comFormulario = await new AxeBuilder({ page }).analyze()
    expect(comFormulario.violations.map(violation => violation.id)).toEqual([])

    await page.getByLabel('Nome da empresa').fill('Bolos da Ana')
    await page.getByLabel('O que a empresa se propõe a fazer').fill('vender bolos caseiros por encomenda no bairro')
    await page.getByLabel('Para quem').fill('moradores do bairro')
    await page.getByRole('button', { name: 'Salvar empresa' }).click()
    await expect(page.getByRole('heading', { level: 3, name: 'Versão 1 do plano' })).toBeVisible()
    const comEmpresa = await new AxeBuilder({ page }).analyze()
    expect(comEmpresa.violations.map(violation => violation.id)).toEqual([])

    // `BUS-02`: o formulário de tarefa e a lista dela, que trazem um `select` e
    // uma seção com título próprio — nenhum dos dois existe nos estados acima.
    await page.getByRole('button', { name: 'Criar uma tarefa para esta empresa' }).click()
    await page.getByLabel('O que você quer que seja criado').fill('uma página para receber encomendas')
    await page.getByRole('button', { name: 'Criar a tarefa' }).click()
    await expect(page.getByLabel('Tarefas desta empresa').getByRole('link', { name: 'uma página para receber encomendas' })).toBeVisible()
    const comTarefa = await new AxeBuilder({ page }).analyze()
    expect(comTarefa.violations.map(violation => violation.id)).toEqual([])
  })

  test('a ajuda passa no axe em qualquer tamanho', async ({ page }) => {
    await page.goto('/studio/ajuda')
    await expect(page.getByRole('heading', { name: 'Ajuda do DZ23 STUDIO' })).toBeVisible()
    const result = await new AxeBuilder({ page }).analyze()
    expect(result.violations).toEqual([])
  })
})

/**
 * O estado do Studio era um botão que não fazia nada, e a visita começava com
 * um alarme que ninguém tinha medido.
 */
test('o estado do Studio começa neutro e abre o que está em atenção', async ({ context, page }) => {
  await context.addCookies([{ name: 'dz23_studio_session', value: 'e2e', url: origin }])
  // Antes de `/health` responder, a tela não pode acusar "Atenção".
  await page.route('**/api/studio/apps/health', async route => {
    await new Promise(resolve => setTimeout(resolve, 1_200))
    await route.fallback()
  })
  await page.goto('/studio/')
  await expect(page.getByRole('button', { name: /Verificando/u })).toBeVisible()
  // Depois da resposta, o botão ABRE o detalhe dos três campos que decidem o
  // estado — antes ele recebia foco, era anunciado como botão e não fazia nada.
  const status = page.locator('.status-wrap button')
  await expect(status).toHaveAttribute('aria-expanded', 'false', { timeout: 10_000 })
  await status.click()
  await expect(status).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByText('O que o Studio está conferindo')).toBeVisible()
  await expect(page.getByText(/inteligência artificial:/u)).toBeVisible()
  await expect(page.getByText(/Ambiente isolado de criação:/u)).toBeVisible()
  await expect(page.getByText(/Espaço em disco:/u)).toBeVisible()
  // T-22: o mesmo painel responde a pergunta que a pessoa realmente faz — e ele
  // responde "ninguém conferiu ainda", porque o endereço de saúde confere as
  // PEÇAS e não cria aplicativo nenhum para descobrir. Um verde aqui seria a
  // tela afirmando a cadeia inteira a partir das partes dela.
  await expect(page.getByText('O que dá para fazer agora')).toBeVisible()
  await expect(page.getByText('Criar um aplicativo: ninguém conferiu ainda.')).toBeVisible()
  await expect(page.getByText(/Nada foi criado ainda nesta instalação/u)).toBeVisible()
})

/**
 * O mesmo caminho, no MODO ESCURO.
 *
 * O produto tinha modo escuro só na tela do assistente: a conversa ficava
 * escura e agradável e, ao voltar para a home, a tela
 * disparava branco puro. Além do susto à noite, meio-tema é onde nascem os
 * contrastes impossíveis — e é o axe que diz se algum sobrou.
 */
test.describe('o mesmo fluxo no modo escuro', () => {
  test.use({ colorScheme: 'dark' })

  test('as telas do fluxo passam no axe com o sistema em modo escuro', async ({ context, page }, testInfo) => {
    await context.addCookies([
      { name: 'dz23_studio_session', value: 'e2e', url: origin },
      { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
    ])
    await context.addInitScript(() => { window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e') })
    const violations: string[] = []
    const check = async (screen: string) => {
      const result = await new AxeBuilder({ page }).analyze()
      for (const violation of result.violations) {
        for (const node of violation.nodes) {
          violations.push(`${testInfo.project.name}/escuro/${screen}: ${violation.id} ${node.html.slice(0, 110)} ${node.any.map(item => JSON.stringify(item.data)).join(' ')}`)
        }
      }
    }
    await page.goto('/studio/')
    await expect(page.getByRole('heading', { name: 'O que posso fazer por você?' })).toBeVisible()
    await check('ideia')
    await page.getByRole('button', { name: 'Página de apresentação' }).click()
    await page.getByRole('button', { name: 'Continuar' }).click()
    /*
      MAPA DE EQUIVALÊNCIA: o título "Só mais alguns detalhes" era o herói do
      CARTÃO DE PERGUNTAS — uma tela própria, com caixa e título grandes, que a
      decisão de produto listou entre o que não pode voltar. A garantia que ele
      carregava era "enviar levou a pessoa adiante"; agora ela é afirmada pelo
      que de fato acontece: a CONVERSA abre, e a pergunta é um lance dela.
    */
    await expect(page.getByLabel('Conversa desta tarefa')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Para quem você quer criar este projeto?')).toBeVisible()
    await check('perguntas')
    await answerIntake(page, INTAKE_ANSWERS)
    await page.getByRole('button', { name: 'Montar meu plano' }).click()
    await expect(page.locator('.plan-list .task-card').first()).toBeVisible({ timeout: 15_000 })
    await check('plano')
    // O fluxo escuro segue até o FIM: a primeira versão parava no plano, e a
    // criação, a verificação e o relato — as telas do pior momento — ficavam
    // sem varredura no escuro.
    await page.getByRole('button', { name: 'Aprovar este plano' }).click()
    await expect(page.getByRole('button', { name: 'Iniciar criação' })).toBeVisible()
    await check('criacao')
    await page.getByRole('button', { name: 'Iniciar criação' }).click()
    // O resultado chega na CONVERSA; o detalhamento continua inteiro, atrás do
    // painel. `tests/resultado.ts` tem o mapa de equivalência.
    await esperarResultado(page)
    await check('conversa')
    await abrirDetalhamento(page)
    await check('detalhamento')
    await fecharDetalhamento(page)

    await page.goto('/studio/ajuda')
    await expect(page.getByRole('heading', { name: 'Ajuda do DZ23 STUDIO' })).toBeVisible()
    await check('ajuda')
    // As telas que a primeira versão do tema escuro deixou brancas sobre
    // brancas. Elas ficam AQUI, e não numa lista à parte, porque foi
    // exatamente o "cobri o que me lembrei" que produziu a regressão.
    await page.goto('/studio/hub')
    await expect(page.locator('.hub-card').first()).toBeVisible({ timeout: 15_000 })
    await check('hub')
    await page.goto('/studio/progresso')
    await expect(page.locator('main, .team-panel, .task-card').first()).toBeVisible({ timeout: 15_000 })
    await check('equipe')
    expect(violations, violations.join('\n')).toEqual([])
  })
})
