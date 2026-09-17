import AxeBuilder from '@axe-core/playwright'
import { expect, request as apiRequest, test } from '@playwright/test'
import { INTAKE_ANSWERS, answerIntake } from './answering'
import { esperarResultado } from './resultado'

test('recusa interface e API sem sessão', async () => {
  const client = await apiRequest.newContext({
    baseURL: 'http://127.0.0.1:4179',
    extraHTTPHeaders: { host: 'studio.dz23.localhost:4179' },
  })
  expect((await client.get('/studio')).status()).toBe(401)
  expect((await client.get('/api/studio/apps/health')).status()).toBe(401)
  await client.dispose()
})

test('o login HTTP local grava sessão host-only sem enfraquecer o modo de servidor', async ({ context, page }) => {
  await page.goto('/login')
  const login = await page.evaluate(async () => {
    const response = await fetch('/api/studio/identity/magic/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test', code: '123456', device_label: 'Chromium local' }),
    })
    const body = await response.json() as { session_generation?: unknown }
    if (typeof body.session_generation === 'string') window.localStorage.setItem('dz23.studio.session-generation.v1', body.session_generation)
    return { status: response.status, generation: window.localStorage.getItem('dz23.studio.session-generation.v1') }
  })
  expect(login).toEqual({ status: 200, generation: expect.stringMatching(/^[a-f0-9]{32}$/u) })
  const cookies = await context.cookies('http://studio.dz23.localhost:4179')
  expect(cookies).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'dz23_studio_session', value: 'session-token', domain: 'studio.dz23.localhost', httpOnly: true, secure: false }),
  ]))
  expect(cookies.some(cookie => cookie.name === 'dz23_studio_csrf')).toBe(false)

  // O NOME FORTE TAMBÉM FOI GRAVADO, sem TLS. É ele que fecha o plantio do
  // vizinho, e este teste existe porque a garantia é do NAVEGADOR e não do
  // servidor: `*.localhost` é contexto seguro, então o Chromium aceita `Secure`
  // sobre http — e recusa `__Host-` que traga `Domain`.
  //
  // A afirmação é sobre o que o navegador ENVIA, e não sobre
  // `context.cookies(url)`: essa consulta filtra por URL e não devolve cookie
  // `Secure` para um endereço `http://`, mesmo estando gravado.
  const enviados = await page.evaluate(async () => (await fetch('/e2e/echo-cookie', { credentials: 'same-origin' })).text())
  expect(enviados).toContain('__Host-dz23_studio_session=session-token')
})

test('o vizinho NAO consegue plantar o nome forte, e por isso nao tranca ninguem', async ({ context, page }) => {
  // O aplicativo GERADO roda numa prévia irmã em HTTP claro, e planta o nome
  // simples à vontade. Plantar num CAMINHO que a remoção não alcança —
  // `Path=/api`, que é onde vive toda a API — deixava a dona do Studio trancada
  // para fora PARA SEMPRE, sem gesto de recuperação e sem custo nenhum para
  // quem plantou.
  //
  // O que fecha isso não é a remoção: é o nome com prefixo. O navegador RECUSA
  // gravar um `__Host-` que traga `Domain`, e este teste prova a recusa no
  // navegador de verdade, não no papel.
  await context.addCookies([
    { name: '__Host-dz23_studio_session', value: 'e2e', domain: 'studio.dz23.localhost', path: '/', secure: true },
    { name: 'dz23_studio_session', value: 'e2e', domain: 'studio.dz23.localhost', path: '/' },
  ])
  await page.goto('/studio/')

  const plantio = await page.evaluate(() => {
    // Exatamente o que o vizinho tenta, nos dois caminhos e nos dois nomes.
    document.cookie = 'dz23_studio_session=plantado; Domain=dz23.localhost; Path=/'
    document.cookie = 'dz23_studio_session=plantado; Domain=dz23.localhost; Path=/api'
    document.cookie = '__Host-dz23_studio_session=plantado; Domain=dz23.localhost; Path=/; Secure'
    return document.cookie
  })
  expect(plantio).toContain('dz23_studio_session=plantado')

  // A afirmação é sobre o que o navegador ENVIA: `context.cookies(url)` filtra
  // por URL e não devolve cookie `Secure` para um endereço `http://`, mesmo
  // estando gravado — o que quase virou a conclusão errada de que o navegador
  // tinha recusado o cookie do servidor.
  const enviados = await page.evaluate(async () => (await fetch('/e2e/echo-cookie', { credentials: 'same-origin' })).text())
  // O nome forte chega UMA vez, e com o valor do servidor.
  expect([...enviados.matchAll(/__Host-dz23_studio_session=([^;]*)/gu)].map(match => match[1])).toEqual(['e2e'])
  // O nome simples chega plantado — é o que antes trancava.
  expect(enviados).toContain('dz23_studio_session=plantado')

  // E o Studio continua respondendo à dona, com o plantio no meio do cabeçalho.
  const status = await page.evaluate(async () => {
    const response = await fetch('/api/studio/identity/session', { credentials: 'same-origin' })
    return response.status
  })
  expect(status).toBe(200)
})

test('abre o Integration Hub pela navegação autenticada do Studio', async ({ context, page }) => {
  await context.addCookies([{ name: 'dz23_studio_session', value: 'e2e', url: 'http://studio.dz23.localhost:4179' }])
  await page.goto('/studio/')
  /*
    MAPA DE EQUIVALÊNCIA: o item único "Integrações" virou dois destinos,
    "Habilidades" e "Plugins", cada um com a vista própria que a decisão pede.
    Este teste segue o de PLUGINS, porque é ele que guarda os conectores e o
    envio de e-mail que o resto do caso confere. O título da tela mudou junto,
    e é o do destino aberto, não mais o do Hub inteiro.
  */
  const link = page.getByRole('link', { name: 'Plugins', exact: true })
  await expect(link).toHaveAttribute('href', '/studio/plugins')
  await link.click()
  await expect(page).toHaveURL(/\/studio\/plugins$/u)
  await expect(page.getByRole('heading', { level: 1, name: 'Plugins' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Voltar ao Studio' })).toHaveAttribute('href', '/studio/')

  // WebMCP: a seção existe, explica o que ficaria exposto, e NESTE navegador
  // diz que o recurso não está disponível — o Chromium deste ambiente não
  // oferece `document.modelContext` (só o Chrome 149+ sob origin trial). Esta
  // é a prova honesta que dá para produzir aqui: a detecção de capacidade
  // funciona em navegador de verdade, e nenhuma ferramenta é registrada.
  // X-04: o ciclo de vida esta na TELA, e nao so no servico. Sem integracao
  // registrada a lista fica vazia, entao o que se prova aqui e que a secao
  // existe e que a tela nao promete o que nao pode fazer.
  await expect(page.getByRole('heading', { name: 'Deixar um agente do navegador usar o Studio' })).toBeVisible()
  await expect(page.getByText('não oferece esse recurso')).toBeVisible()
  await expect(page.getByRole('checkbox')).toHaveCount(0)
  // E o que NUNCA é exposto está escrito na tela, não só no código.
  await expect(page.getByText('parada de emergência')).toBeVisible()
  expect(await page.evaluate(() => 'modelContext' in document)).toBe(false)
})

/**
 * O trecho verificado desta jornada ROda.
 *
 * Ele ficou desligado por um diagnóstico ERRADO: a bandeira dizia que
 * `pipeline.ts` fechava no caminho de sucesso e que o produto não tinha
 * atestação. O `throw` está dentro de `if (facts === undefined)`, e quem não
 * devolvia `facts` era o SERVIDOR DE TESTE — o resolvedor de verdade
 * (`builder-resolver.ts:181`) sempre devolveu imagem, política e escopo. O
 * efeito de acreditar no diagnóstico foi caro: prévia, notificação, protótipo
 * verificado e a ÚNICA varredura de acessibilidade da página inteira ficaram
 * sem teste, e ninguém veria uma regressão em nenhum deles.
 *
 * O que o teste dobra são os FATOS do construtor; a atestação, os resumos e o
 * veredito continuam sendo calculados pelo produto.
 */
const VERIFIED_JOURNEY_REACHABLE = true

test('percorre as cinco etapas, muda privacidade e termina sem alegar publicação', async ({ context, page }) => {
  const admissionPosts: Array<{ readonly hasTicket: boolean; readonly origin: string; readonly url: string }> = []
  const requestedUrls: string[] = []
  const mutationBodies: unknown[] = []
  page.on('request', request => {
    requestedUrls.push(request.url())
    if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/studio/apps/')) {
      try { mutationBodies.push(request.postDataJSON()) } catch { /* uploads are binary and carry no authority fields */ }
    }
    if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/__dz23/admission') return
    const payload = request.postDataJSON() as unknown
    void request.allHeaders().then(headers => {
      admissionPosts.push({
        hasTicket: typeof payload === 'object' && payload !== null && 'ticket' in payload && typeof (payload as { ticket?: unknown }).ticket === 'string',
        origin: headers.origin ?? '',
        url: request.url(),
      })
    })
  })
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: 'http://studio.dz23.localhost:4179' },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: 'http://studio.dz23.localhost:4179' },
  ])
  await context.addInitScript(() => {
    window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e')
    const shown: Array<{ title: string; body: string; tag?: string }> = []
    let permissionRequests = 0
    ;(window as unknown as { __dz23Notifications: typeof shown }).__dz23Notifications = shown
    ;(window as unknown as { __dz23PermissionRequests: () => number }).__dz23PermissionRequests = () => permissionRequests
    class FakeNotification {
      static permission: NotificationPermission = 'default'
      static async requestPermission(): Promise<NotificationPermission> { permissionRequests++; FakeNotification.permission = 'granted'; return 'granted' }
      constructor(title: string, options?: NotificationOptions) { shown.push({ title, body: options?.body ?? '', ...(options?.tag === undefined ? {} : { tag: options.tag }) }) }
    }
    Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true })
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true })
    Object.defineProperty(navigator.serviceWorker, 'ready', {
      configurable: true,
      get: () => Promise.resolve({
        showNotification: (title: string, options?: NotificationOptions) => {
          shown.push({ title, body: options?.body ?? '', ...(options?.tag === undefined ? {} : { tag: options.tag }) })
          return Promise.resolve()
        },
      } as unknown as ServiceWorkerRegistration),
    })
  })
  const studioResponse = await page.goto('/studio')
  const studioPolicy = studioResponse?.headers()['content-security-policy'] ?? ''
  expect(studioPolicy).toContain('frame-src http://*.dz23.localhost:4179')
  expect(studioPolicy).toContain("frame-ancestors 'none'")
  const notificationOptIn = page.getByRole('button', { name: 'Avisar quando a criação terminar' })
  await expect(notificationOptIn).toBeVisible()
  await notificationOptIn.click()
  /*
    MAPA DE EQUIVALÊNCIA: o aviso de notificação virou um SINO no rodapé do
    trilho, como na referência, e o estado concedido é o nome acessível dele —
    com `role="status"`, que é como um controle compacto entrega uma frase.

    A frase exigida é a MESMA, palavra por palavra. O que mudou é onde ela é
    lida: no nome acessível e no título, em vez de ocupar uma linha de texto ao
    lado da conta. A conferência ficou mais estrita, e não menos: antes bastava
    o texto existir em algum lugar da página.
  */
  await expect(page.getByRole('status', { name: 'Este aparelho vai avisar quando a criação terminar.' })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __dz23PermissionRequests: () => number }).__dz23PermissionRequests())).toBe(1)
  await expect(page.getByRole('button', { name: 'Painel para criar, editar e excluir' })).toBeVisible()
  // Privacidade vive em "Ajustes desta tarefa" desde a migração para o
  // workspace aprovado. Continua inteira: os três perfis, a frase de cada um e
  // o aviso que nomeia a rota.
  await page.getByText('Ajustes desta tarefa', { exact: true }).click()
  await expect(page.getByText('Seus dados não são enviados para serviços externos.')).toBeVisible()
  // O seletor virou os três perfis nomeados (M-05); o segundo é o Equilibrado,
  // o único que continua nomeando a rota externa na frase de privacidade.
  await page.locator('.privacy-profiles label').nth(1).click()
  await expect(page.locator('.privacy-notice')).toContainText('ollama-local')
  await page.getByRole('button', { name: 'Página de apresentação' }).click()
  await page.getByRole('button', { name: 'Continuar' }).click()
  await answerIntake(page, INTAKE_ANSWERS)
  await page.getByRole('button', { name: 'Montar meu plano' }).click()
  await page.getByLabel('O que precisa mudar?').fill('Mostrar o contato antes dos serviços.')
  await page.getByRole('button', { name: 'Enviar pedido de mudança' }).click()
  await page.getByRole('button', { name: 'Montar plano revisado' }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('.plan-list .task-card')).toHaveCount(2)
  const lastSlice = page.locator('.plan-list .task-card h2').last()
  // E-03: a pessoa EDITA o plano antes de aprovar, no navegador de verdade e
  // no tamanho de celular. Renomear e reordenar são as duas coisas que ela faz
  // sem precisar explicar nada por escrito.
  await expect(page.getByText('definidos pelo Studio')).toBeVisible()
  await page.locator('.plan-list .task-card').last().getByRole('button', { name: 'Editar esta parte' }).click()
  await page.getByLabel('Nome desta parte').fill('Fale conosco')
  await page.getByLabel('Como vamos conferir (uma linha por item)').fill('O contato fica visível.\nO telefone aparece.')
  const editedPromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/plan/edit'))
  await page.getByRole('button', { name: 'Guardar minha alteração' }).click()
  expect((await editedPromise).status()).toBe(200)
  await expect(page.locator('.plan-list .task-card h2').last()).toContainText('Fale conosco')
  /*
    A busca é feita DENTRO do editor de plano, e não na página inteira.

    A conversa também guarda o plano, como um lance recolhível — as duas
    superfícies falam do mesmo plano, e é assim que tem de ser: uma é o
    histórico, a outra é onde se edita. Procurar na página inteira encontrava
    as duas e reprovava por ambiguidade, o que é o teste pedindo que se diga
    qual das duas se quer conferir. Esta quer conferir o EDITOR.
  */
  const editor = page.getByLabel('Confira o plano')
  await expect(editor.getByText('O telefone aparece.')).toBeVisible()
  await expect(page.getByText('Este plano tem alterações suas.')).toBeVisible()
  // Subir: a parte editada passa a ser a primeira, e o plano continua com duas partes.
  await page.locator('.plan-list .task-card').last().getByRole('button', { name: 'Subir: Fale conosco' }).click()
  await expect(page.locator('.plan-list .task-card h2').first()).toContainText('Fale conosco')
  await expect(page.locator('.plan-list .task-card')).toHaveCount(2)
  // E tirar volta a ordem ao que o teste seguinte espera não é possível: em vez
  // disso descemos de novo, porque tirar uma parte mudaria o que é gerado.
  await page.locator('.plan-list .task-card').first().getByRole('button', { name: 'Descer: Fale conosco' }).click()
  await expect(page.locator('.plan-list .task-card h2').last()).toContainText('Fale conosco')
  // A tela do plano EDITÁVEL é onde a pessoa leiga toma a decisão. Se ela tem
  // violação de acessibilidade, quem usa leitor de tela decide no escuro.
  const planScan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(planScan.violations.map(violation => violation.id)).toEqual([])
  const approveButton = page.getByRole('button', { name: 'Aprovar este plano' })
  await expect(lastSlice).toBeVisible()
  await expect(lastSlice).toContainText('Fale conosco')
  expect(await lastSlice.evaluate((node, approve) => Boolean(node.compareDocumentPosition(approve as Node) & Node.DOCUMENT_POSITION_FOLLOWING), await approveButton.elementHandle())).toBe(true)
  await approveButton.click()
  const acceptedPromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/generate'))
  await page.getByRole('button', { name: 'Iniciar criação' }).click()
  const accepted = await acceptedPromise
  expect(accepted.status()).toBe(202)
  const acceptedBody = await accepted.json() as { run_id: string }
  expect(acceptedBody.run_id).toMatch(/^operation-/u)
  // A pessoa lê a FRASE, não o código. O código técnico continua existindo, mas
  // atrás de "Detalhes técnicos": antes ele era a primeira coisa na tela, em
  // inglês e em caixa alta, para quem não programa.
  if (VERIFIED_JOURNEY_REACHABLE) {
    await esperarResultado(page, 30_000)
  } else {
    // O desfecho BLOQUEADO também vira lance da conversa, com o estado dele —
    // e não um selo genérico. É o aceite VIS-12 em caminho real.
    await expect(page.getByText('Parou por falta de algo fora daqui').first()).toBeVisible({ timeout: 20_000 })
  }
  // E-06/E-07: mesmo terminando bloqueada, a criação EXPLICA o que aconteceu.
  // Antes disto a pessoa terminava com um código em inglês e nada mais. O
  // relato continua inteiro; ele agora abre no painel, sob demanda.
  await page.getByRole('button', { name: 'Ver o detalhamento técnico' }).click()
  if (!VERIFIED_JOURNEY_REACHABLE) {
    // O código técnico continua existindo, mas atrás de "Detalhes técnicos":
    // antes ele era a primeira coisa na tela, em inglês e em caixa alta, para
    // quem não programa.
    await expect(page.getByText('ACCEPTANCE_ATTESTATION_UNAVAILABLE')).toBeHidden()
    await page.locator('.result-technical > summary').click()
    await expect(page.getByText('ACCEPTANCE_ATTESTATION_UNAVAILABLE')).toBeVisible()
  }
  await expect(page.getByRole('heading', { name: 'O que aconteceu na criação' })).toBeVisible({ timeout: 20_000 })
  /*
    As frases são procuradas DENTRO do relato, e não na página inteira.

    A conversa também nomeia os passos do construtor, na linha do tempo do
    lance da tentativa — as duas superfícies falam do mesmo trabalho, e é
    assim que tem de ser. Procurar na página inteira encontrava as duas e
    reprovava por ambiguidade, o que é o teste dizendo "diga qual das duas
    você quer conferir". Esta quer conferir o RELATO.
  */
  const relato = page.getByLabel('O que aconteceu na criação')
  await expect(relato.getByText('Preparando as ferramentas do seu aplicativo')).toBeVisible()
  await expect(relato.getByText('Usando o aplicativo como uma pessoa usaria')).toBeVisible()
  await expect(page.getByText('O que foi feito para você')).toBeVisible()
  await expect(page.getByText('escrito pela IA').first()).toBeVisible()
  // O detalhe técnico existe em cada etapa que rodou, e vem FECHADO: a pessoa
  // lê a frase primeiro e abre o técnico se quiser.
  const stageDetails = page.locator('.run-report .run-stage details')
  await expect(stageDetails).toHaveCount(4)
  expect(await stageDetails.first().evaluate(node => (node as HTMLDetailsElement).open)).toBe(false)
  await stageDetails.first().locator('summary').click()
  expect(await stageDetails.first().evaluate(node => (node as HTMLDetailsElement).open)).toBe(true)

  // O que mais importa nesta tela: mesmo terminando mal, ela não alega
  // publicação nenhuma.
  await expect(page.getByText('publicado na internet', { exact: false })).toHaveCount(0)
  // E diz, com todas as letras, onde os arquivos estão: no computador dela.
  await expect(page.getByText('Nada saiu do seu computador')).toBeVisible()
  // O botão da prévia só existe quando há protótipo para ver.
  await expect(page.getByRole('button', { name: 'Ver meu protótipo' })).toHaveCount(VERIFIED_JOURNEY_REACHABLE ? 1 : 0)
  expect(JSON.stringify(mutationBodies)).not.toMatch(/org_id|tenant_id|bootstrap_owner|"role"/u)

  if (!VERIFIED_JOURNEY_REACHABLE) {
    test.info().annotations.push({
      type: 'lacuna',
      description: 'Protótipo verificado e prévia não são alcançáveis: pipeline.ts:213 lança ACCEPTANCE_ATTESTATION_UNAVAILABLE no caminho de sucesso.',
    })
    return
  }

  // A frase permanente sob as etapas, e não qualquer eco dela dentro de
  // "Detalhes técnicos" — o `.first()` de antes casava com um `<code>` fechado.
  await expect(page.locator('p.truth')).toContainText('não está publicado nem disponível para outras pessoas')
  // A pessoa lê a CONFERÊNCIA, não o identificador. `page:Início` continua na
  // tela, pequeno e ao lado, porque é ele que se cola num pedido de ajuda — mas
  // a lista deixou de ser um despejo de `page:`, `entity:`, `field:` na única
  // tela que responde "meu aplicativo faz o que eu pedi?".
  await expect(page.getByText('A página Início existe: Passou')).toBeVisible()
  await expect(page.getByText('A navegação deve ser simples.: Não verificado automaticamente')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __dz23Notifications: unknown[] }).__dz23Notifications.length)).toBe(1)
  expect(await page.evaluate(() => (window as unknown as { __dz23Notifications: Array<{ title: string; body: string; tag?: string }> }).__dz23Notifications)).toEqual([
    { title: 'DZ23 STUDIO', body: 'Seu protótipo foi verificado.', tag: `dz23-generation-${acceptedBody.run_id}` },
  ])
  await page.evaluate(({ runId }) => window.dispatchEvent(new CustomEvent('dz23:generation-finished', { detail: { state: 'VERIFIED_PROTOTYPE', runId } })), { runId: acceptedBody.run_id })
  expect(await page.evaluate(() => (window as unknown as { __dz23Notifications: unknown[] }).__dz23Notifications.length)).toBe(1)
  expect(JSON.stringify(mutationBodies)).not.toMatch(/org_id|tenant_id|bootstrap_owner|"role"/u)

  const openPreview = page.getByRole('button', { name: 'Ver meu protótipo' })
  await expect(openPreview).toBeVisible()
  await openPreview.click()
  const previewFrameElement = page.getByTitle('Prévia isolada do protótipo')
  await expect(previewFrameElement).toHaveAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin')
  await expect(page.getByText('Isto é uma prévia local. Seu aplicativo não foi publicado na internet.')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Ver meu protótipo' })).toHaveCount(0)
  const previewFrame = page.frameLocator('iframe[title="Prévia isolada do protótipo"]')
  await expect(previewFrame.getByRole('heading', { name: 'Protótipo E2E carregado' })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('cliente@preview.local')).toBeVisible()
  await expect(page.getByText('482901')).toBeVisible()

  // O COOKIE SOMBRA FOI EMBORA, e esta afirmação virou de lado de propósito.
  //
  // O aplicativo GERADO da prévia grava `dz23_studio_session=shadow;
  // Domain=dz23.localhost` — está no HTML do protótipo de prova, e é o ataque
  // real: prévia e Studio são subdomínios irmãos em HTTP claro.
  //
  // Este teste exigia que os DOIS cookies sobrevivessem, porque o servidor
  // tolerava a ambiguidade tentando os candidatos um a um. Esse laço era metade
  // de um roubo de conta e foi removido; recusar a ambiguidade, porém, trocou o
  // roubo por uma TRANCA: a dona do Studio parava de conseguir ler qualquer
  // coisa, e foi assim que esta linha ficou vermelha.
  //
  // Agora a recusa vem acompanhada da remoção do cookie do vizinho — que leva
  // `Domain` e por isso não alcança o host-only legítimo. Sobra UM, e o pedido
  // seguinte volta a funcionar sozinho: as duas linhas acima, que leem o código
  // de verificação, são a prova de que voltou.
  const studioSessionCookies = (await context.cookies('http://studio.dz23.localhost:4179'))
    .filter(cookie => cookie.name === 'dz23_studio_session')
  expect(studioSessionCookies).toEqual([
    expect.objectContaining({ value: 'e2e', domain: 'studio.dz23.localhost' }),
  ])

  const frameUrl = await previewFrameElement.getAttribute('src').then(src => new URL(src!, page.url()))
  const loadedPreviewFrame = page.frames().find(frame => frame !== page.mainFrame() && frame.url().includes('.dz23.localhost:4179/'))
  expect(loadedPreviewFrame).toBeDefined()
  expect(page.url()).not.toMatch(/[?&#]ticket=/iu)
  expect(frameUrl.href).not.toMatch(/[?&#]ticket=/iu)
  expect(loadedPreviewFrame!.url()).not.toMatch(/[?&#]ticket=/iu)
  expect(requestedUrls.every(url => !/[?&#]ticket=/iu.test(url))).toBe(true)
  await expect.poll(() => admissionPosts.length).toBe(1)
  expect(admissionPosts[0]).toEqual({ hasTicket: true, origin: frameUrl.origin, url: `${frameUrl.origin}/__dz23/admission` })
  await expect.poll(() => requestedUrls.some(url => new URL(url).pathname === '/__dz23/refresh')).toBe(true)
  await expect.poll(() => page.locator('iframe[aria-hidden="true"]').count(), { timeout: 7_000 }).toBe(0)

  const beforeForgery = admissionPosts.length
  await page.evaluate(previewOrigin => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Prévia isolada do protótipo"]')
    if (frame?.contentWindow == null) throw new Error('preview frame missing')
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'http://attacker.example', source: frame.contentWindow, data: { type: 'DZ23_PREVIEW_READY' },
    }))
    window.dispatchEvent(new MessageEvent('message', {
      origin: previewOrigin, source: window, data: { type: 'DZ23_PREVIEW_READY' },
    }))
  }, frameUrl.origin)
  await page.waitForTimeout(100)
  expect(admissionPosts).toHaveLength(beforeForgery)

  await page.getByRole('button', { name: 'Encerrar prévia' }).click()
  await expect(previewFrameElement).toHaveCount(0)
  await expect(page.getByText('A prévia foi encerrada. O protótipo continua salvo no projeto.')).toBeVisible()
  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])
})
