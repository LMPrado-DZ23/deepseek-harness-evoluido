import AxeBuilder from '@axe-core/playwright'
import { expect, request as apiRequest, test } from '@playwright/test'
import { INTAKE_ANSWERS, answerIntake } from './answering'
import { esperarResultado } from './resultado'

test('recusa interface e API sem sessão', async () => {
  /*
    ESTE SERVIDOR DE TESTE É UMA INSTALAÇÃO DE SERVIDOR, e o que faz dele uma é
    a AUSÊNCIA de `personalSession` no dublê de identidade.

    A porta do modo pessoal existe desde 18/09/2026 e mora num lugar só,
    `authenticatedMutation`. Ela abre quando a identidade oferece uma sessão
    pessoal — instalação local, presa a `127.0.0.1`, sem ninguém registrado. Um
    serviço que não ofereça o método não ganha porta nenhuma, e é isso que faz
    as duas recusas abaixo continuarem sendo recusas: aqui há dona, e ela entra
    com cookie no teste seguinte.

    A instalação PESSOAL, que é a de quem acabou de baixar o produto, tem casos
    próprios em `plugins/identity/tests/http.spec.ts` e foi medida contra o
    produto montado (`ABRIR-02` no livro mestre).
  */
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

  // O QUE O SERVIDOR EMITE é conferido primeiro, e sem navegador no meio.
  //
  // Esta parte não depende de versão de nada: a emissão dos DOIS nomes é
  // decisão do servidor, e é ela que este teste tem de travar. A parte
  // seguinte, que é a do navegador, só pode ser conferida DEPOIS de saber que
  // houve o que guardar.
  const direto = await apiRequest.newContext({
    baseURL: 'http://127.0.0.1:4179',
    extraHTTPHeaders: { host: 'studio.dz23.localhost:4179', origin: 'http://studio.dz23.localhost:4179' },
  })
  const emissao = await direto.post('/api/studio/identity/magic/verify', {
    data: { email: 'owner@example.test', code: '123456', device_label: 'Conferência direta' },
  })
  expect(emissao.status()).toBe(200)
  const emitidos = emissao.headersArray().filter(cabecalho => cabecalho.name.toLowerCase() === 'set-cookie').map(cabecalho => cabecalho.value)
  expect(emitidos.some(valor => valor.startsWith('__Host-dz23_studio_session=') && valor.includes('Secure') && valor.includes('Path=/'))).toBe(true)
  expect(emitidos.some(valor => valor.startsWith('dz23_studio_session='))).toBe(true)
  await direto.dispose()

  // E AGORA O NAVEGADOR — com a capacidade dele MEDIDA, não suposta.
  //
  // Este teste já afirmou, em comentário e em asserção, que "o Chromium aceita
  // `Secure` sobre http em `*.localhost` e portanto grava o `__Host-`". A
  // primeira metade é verdade em toda versão medida; a SEGUNDA não é. Medido
  // com o mesmo servidor e o mesmo endereço:
  //
  // | Chromium | `Secure` sobre http | prefixo `__Host-` sobre http |
  // | --- | --- | --- |
  // | 133.0.6943.16 | aceita | **RECUSA** |
  // | 141.0.7390.37 | aceita | aceita |
  //
  // A máquina de quem desenvolve forçava o 141 e a CI instalava o 133 — e foi
  // essa assimetria, e não o produto, que deixou a asserção antiga passar aqui
  // e reprovar lá. A consequência de produto está registrada em
  // `INTERNAL_BLOCKERS.md`: onde o navegador recusa o prefixo, o nome forte
  // NÃO é a defesa, e sobra a rede de `shadowCookieDeletions`.
  //
  // A sonda usa um cookie PRÓPRIO, sem relação com a sessão, porque perguntar
  // ao navegador se ele gravou o nosso cookie para decidir se ele deveria ter
  // gravado o nosso cookie não conferiria nada.
  const aceitaPrefixo = await page.evaluate(() => {
    document.cookie = '__Host-dz23_sonda=1; Path=/; Secure; SameSite=Lax'
    return document.cookie.includes('__Host-dz23_sonda=1')
  })

  // A afirmação é sobre o que o navegador ENVIA, e não sobre
  // `context.cookies(url)`: essa consulta filtra por URL e não devolve cookie
  // `Secure` para um endereço `http://`, mesmo estando gravado.
  const enviados = await page.evaluate(async () => (await fetch('/e2e/echo-cookie', { credentials: 'same-origin' })).text())
  if (aceitaPrefixo) {
    // Onde o prefixo é aceito, ele TEM de estar lá: é o que fecha o plantio.
    expect(enviados).toContain('__Host-dz23_studio_session=session-token')
  } else {
    // Onde não é, a exigência continua existindo, do outro lado: a sessão não
    // pode ficar de fora por causa do nome que o navegador recusou.
    expect(enviados).not.toContain('__Host-dz23_studio_session=')
  }
  // Nos DOIS casos o nome simples é a rede, e ele é sempre conferido.
  expect(enviados).toContain('dz23_studio_session=session-token')
})

test('o vizinho NAO consegue plantar o nome forte, e por isso nao tranca ninguem', async ({ context, page }) => {
  // O aplicativo GERADO roda numa prévia irmã em HTTP claro, e planta o nome
  // simples à vontade. Plantar num CAMINHO que a remoção não alcança —
  // `Path=/api`, que é onde vive toda a API — deixava a dona do FRIGG trancada
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

  // E o FRIGG continua respondendo à dona, com o plantio no meio do cabeçalho.
  const status = await page.evaluate(async () => {
    const response = await fetch('/api/studio/identity/session', { credentials: 'same-origin' })
    return response.status
  })
  expect(status).toBe(200)
})

test('abre o Integration Hub pela navegação autenticada do FRIGG', async ({ context, page }) => {
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
  await expect(page.getByRole('link', { name: 'Voltar ao FRIGG' })).toHaveAttribute('href', '/studio/')

  // WebMCP: a seção existe, explica o que ficaria exposto, e NESTE navegador
  // diz que o recurso não está disponível — o Chromium deste ambiente não
  // oferece `document.modelContext` (só o Chrome 149+ sob origin trial). Esta
  // é a prova honesta que dá para produzir aqui: a detecção de capacidade
  // funciona em navegador de verdade, e nenhuma ferramenta é registrada.
  // X-04: o ciclo de vida esta na TELA, e nao so no servico. Sem integracao
  // registrada a lista fica vazia, entao o que se prova aqui e que a secao
  // existe e que a tela nao promete o que nao pode fazer.
  await expect(page.getByRole('heading', { name: 'Deixar um agente do navegador usar o FRIGG' })).toBeVisible()
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
  await expect(page.getByText('definidos pelo FRIGG')).toBeVisible()
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
    { title: 'FRIGG', body: 'Seu protótipo foi verificado.', tag: `dz23-generation-${acceptedBody.run_id}` },
  ])
  await page.evaluate(({ runId }) => window.dispatchEvent(new CustomEvent('dz23:generation-finished', { detail: { state: 'VERIFIED_PROTOTYPE', runId } })), { runId: acceptedBody.run_id })
  expect(await page.evaluate(() => (window as unknown as { __dz23Notifications: unknown[] }).__dz23Notifications.length)).toBe(1)
  expect(JSON.stringify(mutationBodies)).not.toMatch(/org_id|tenant_id|bootstrap_owner|"role"/u)

  const openPreview = page.getByRole('button', { name: 'Ver meu protótipo' })
  await expect(openPreview).toBeVisible()
  await openPreview.click()
  const previewFrameElement = page.getByTitle('Seu aplicativo rodando, isolado')
  await expect(previewFrameElement).toHaveAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin')
  await expect(page.getByText('Isto roda no seu computador. Seu aplicativo não foi publicado na internet.')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Ver meu protótipo' })).toHaveCount(0)
  const previewFrame = page.frameLocator('iframe[title="Seu aplicativo rodando, isolado"]')
  await expect(previewFrame.getByRole('heading', { name: 'Protótipo E2E carregado' })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('cliente@preview.local')).toBeVisible()
  await expect(page.getByText('482901')).toBeVisible()

  // O COOKIE SOMBRA FOI EMBORA, e esta afirmação virou de lado de propósito.
  //
  // O aplicativo GERADO da prévia grava `dz23_studio_session=shadow;
  // Domain=dz23.localhost` — está no HTML do protótipo de prova, e é o ataque
  // real: prévia e FRIGG são subdomínios irmãos em HTTP claro.
  //
  // Este teste exigia que os DOIS cookies sobrevivessem, porque o servidor
  // tolerava a ambiguidade tentando os candidatos um a um. Esse laço era metade
  // de um roubo de conta e foi removido; recusar a ambiguidade, porém, trocou o
  // roubo por uma TRANCA: a dona do FRIGG parava de conseguir ler qualquer
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
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Seu aplicativo rodando, isolado"]')
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

  /*
    O PAINEL DE PRÉVIA, exercitado no navegador de verdade.

    A decisão de o que mostrar, a conferência de rota e as transições de layout
    têm teste de unidade próprio. O que SÓ o navegador responde é se a coisa
    está ligada: se o quadro muda de largura, se a conversa continua ali, e se o
    rascunho que a pessoa escreveu sobrevive a abrir e fechar o painel.
  */
  await expect(page.locator('.dz-previa-situacao strong')).toHaveText('Disponível')
  await expect(page.getByText('Só páginas do seu aplicativo. Este campo não abre outros endereços.')).toBeVisible()

  /*
    A MENSAGEM DO QUADRO CHEGA — e esta é a prova de MONTAGEM que faltava.

    Uma revisão externa achou, lendo o código, que o painel usava
    `ref={refDoQuadro ?? quadro}`: com o ref de fora passado pelo `App`, o de
    dentro ficava nulo, a conferência comparava `evento.source` com `undefined`
    e TODAS as mensagens do quadro eram recusadas — inclusive as legítimas.

    Nenhum teste de função pegava isso, porque o defeito não estava na função.
    Este caso monta o produto inteiro e manda a mensagem do quadro DE VERDADE.
  */
  await expect(page.getByLabel('Página')).toHaveValue('/')
  await page.evaluate(previewOrigin => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Seu aplicativo rodando, isolado"]')
    if (frame?.contentWindow == null) throw new Error('preview frame missing')
    window.dispatchEvent(new MessageEvent('message', {
      origin: previewOrigin, source: frame.contentWindow, data: { type: 'DZ23_PREVIEW_ROUTE', path: '/placar' },
    }))
  }, frameUrl.origin)
  await expect(page.getByLabel('Página')).toHaveValue('/placar')

  // E a mesma mensagem de OUTRA janela continua sendo ignorada: consertar a
  // ligação não pode afrouxar a conferência.
  await page.evaluate(previewOrigin => {
    window.dispatchEvent(new MessageEvent('message', {
      origin: previewOrigin, source: window, data: { type: 'DZ23_PREVIEW_ROUTE', path: '/forjada' },
    }))
  }, frameUrl.origin)
  await page.waitForTimeout(100)
  await expect(page.getByLabel('Página')).toHaveValue('/placar')

  // O COMPOSITOR continua alcançável com o painel aberto, e o que a pessoa
  // escreveu nele é o que tem de sobreviver ao resto deste bloco.
  const compositor = page.getByRole('textbox', { name: /mensagem|pedido|escreva/iu }).first()
  await compositor.fill('quero uma casa a mais no tabuleiro')

  // DESKTOP → CELULAR muda a largura do quadro de verdade, e não desenha uma
  // moldura de telefone.
  const moldura = page.locator('.dz-previa-quadro')
  const larguraNoDesktop = await moldura.evaluate(elemento => elemento.getBoundingClientRect().width)
  await page.getByRole('button', { name: 'Celular' }).click()
  await expect(page.getByText('Isto muda a largura da tela. Não é um aplicativo Android ou iPhone.')).toBeVisible()
  await expect.poll(() => moldura.evaluate(elemento => elemento.getBoundingClientRect().width)).toBeLessThanOrEqual(390)
  await page.getByRole('button', { name: 'Computador' }).click()
  await expect.poll(() => moldura.evaluate(elemento => elemento.getBoundingClientRect().width)).toBe(larguraNoDesktop)

  // EXPANDIR e RESTAURAR: a conversa continua no documento — é lá que moram o
  // marco principal e o título da página.
  await page.getByRole('button', { name: 'Expandir a prévia' }).click()
  await expect(page.locator('main.dz-tarefa-conversa')).toHaveCount(1)
  await page.getByRole('button', { name: 'Voltar ao modo dividido' }).click()

  // FECHAR O PAINEL não encerra a prévia nem perde o rascunho.
  await expect(page.getByText('Fechar o painel não interrompe a construção nem encerra a prévia.')).toBeVisible()
  await page.getByRole('button', { name: 'Fechar o painel' }).first().click()
  await expect(page.locator('.dz-previa-quadro')).toHaveCount(0)
  await expect(compositor).toHaveValue('quero uma casa a mais no tabuleiro')
  await page.getByRole('button', { name: 'Seu protótipo local' }).click()
  await expect(page.locator('.dz-previa-quadro')).toHaveCount(1)
  await expect(compositor).toHaveValue('quero uma casa a mais no tabuleiro')

  await page.getByRole('button', { name: 'Encerrar a prévia' }).click()
  await expect(previewFrameElement).toHaveCount(0)
  await expect(page.getByText('Você encerrou a prévia. A tarefa e os arquivos continuam salvos.')).toBeVisible()
  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])
})

test('a resposta se perde, a pessoa reenvia, e a conversa continua com UMA mensagem', async ({ context, page }) => {
  /*
    A jornada que o defeito produzia: a pessoa pergunta, o servidor ACEITA, a
    resposta se perde no caminho, ela aperta de novo — e ficava com duas
    mensagens iguais na conversa.

    Aqui o reenvio é feito do próprio navegador, com a chave de intenção que a
    tela usa, e a conferência é depois de um RELOAD: o que importa não é o que a
    tela desenhou, é o que ficou guardado.
  */
  const origin = 'http://studio.dz23.localhost:4179'
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
  await context.addInitScript(() => { window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e') })
  await page.goto('/studio/')
  await page.getByRole('button', { name: 'Página de apresentação' }).click()
  await page.getByRole('button', { name: 'Continuar' }).click()
  await answerIntake(page, INTAKE_ANSWERS)
  await page.getByRole('button', { name: 'Montar meu plano' }).click()
  await expect(page.getByText('Plano proposto', { exact: false })).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Aprovar este plano' }).click()
  await page.getByRole('button', { name: 'Iniciar criação' }).click()
  await esperarResultado(page)

  const projeto = new URL(page.url()).searchParams.get('projeto')!
  const enviar = async () => page.evaluate(async ([id, chave]) => {
    const resposta = await fetch(`/api/studio/apps/projects/${id}/ask`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-dz23-csrf': 'csrf-e2e' },
      body: JSON.stringify({ question: 'por que a montagem demorou?', request_key: chave }),
    })
    return resposta.status
  }, [projeto, 'chave-de-envio-e2e-01'] as const)

  expect(await enviar()).toBe(201)
  // O reenvio: mesma intenção, mesma chave.
  expect(await enviar()).toBe(201)

  await page.reload()
  await expect(page.getByLabel('Conversa desta tarefa')).toBeVisible({ timeout: 20_000 })
  // UMA mensagem, e não duas. E a ordem do histórico continua a mesma.
  await expect(page.getByText('por que a montagem demorou?')).toHaveCount(1)
})

/**
 * O MODO EMPRESA, ponta a ponta — `BUS-01`.
 *
 * A ação nova que uma pessoa passa a conseguir completar: cadastrar a empresa
 * com objetivo, público e limites, ver o plano gravado com a versão dele,
 * gravar uma versão NOVA sem apagar a anterior, e arquivar.
 *
 * O que este caso exercita não é a tela sozinha: as regras de versão, a recusa
 * de plano repetido e o isolamento são o serviço de produção, montado no
 * manipulador de workspace que autentica e confere o CSRF de verdade. O dublê
 * é só onde as linhas ficam guardadas.
 */
test('cadastra a empresa, revisa o plano sem perder a versão anterior, e arquiva', async ({ context, page }) => {
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: 'http://studio.dz23.localhost:4179' },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: 'http://studio.dz23.localhost:4179' },
  ])
  // A pré-condição é EXPLÍCITA: o armazenamento deste servidor é um só para a
  // execução inteira, e afirmar "nenhuma empresa" sem zerar é depender da ordem
  // em que os casos rodaram — que foi a causa de CI número sete.
  await page.request.get('http://127.0.0.1:4179/e2e/reset-business')
  await page.goto('/studio/empresas')
  await expect(page.getByRole('heading', { level: 1, name: 'Empresas' })).toBeVisible()
  // A tela diz que não há nenhuma — que é diferente de não ter conseguido ler.
  await expect(page.getByText('Você ainda não cadastrou nenhuma empresa.')).toBeVisible()

  await page.getByRole('button', { name: 'Cadastrar empresa' }).click()
  // O botão de salvar nasce DESLIGADO, e a tela diz o que falta: quem clica num
  // botão ligado que recusa depois aprende a desconfiar do produto.
  const salvar = page.getByRole('button', { name: 'Salvar empresa' })
  await expect(salvar).toBeDisabled()
  await expect(page.getByText('Escreva o nome da empresa, com pelo menos 2 letras.')).toBeVisible()

  await page.getByLabel('Nome da empresa').fill('Bolos da Ana')
  await expect(page.getByText('Descreva o objetivo com pelo menos 10 letras.')).toBeVisible()
  await page.getByLabel('O que a empresa se propõe a fazer').fill('vender bolos caseiros por encomenda no bairro')
  await page.getByLabel('Para quem').fill('moradores do bairro')
  await page.getByLabel('O que ela entrega').fill('bolo de 1kg com 2 dias de antecedência')
  await page.getByLabel('O que ela não faz').fill('não entrega fora do bairro\nsó aceita encomenda com 2 dias')
  await expect(salvar).toBeEnabled()
  await salvar.click()

  await expect(page.getByText('Empresa cadastrada, com a primeira versão do plano.')).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: 'Bolos da Ana' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 3, name: 'Versão 1 do plano' })).toBeVisible()
  // Cada limite é um item conferível sozinho, e não um parágrafo com os dois.
  await expect(page.locator('.dz-empresa-plano').getByRole('listitem')).toHaveText([
    'não entrega fora do bairro', 'só aceita encomenda com 2 dias',
  ])

  // A revisão abre COM o plano vigente dentro, e recusa gravar o que não mudou.
  await page.getByRole('button', { name: 'Salvar uma versão nova do plano' }).first().click()
  const gravar = page.getByRole('button', { name: 'Salvar uma versão nova do plano' }).last()
  await expect(page.getByText('Este plano é igual ao que já está gravado.')).toBeVisible()
  await expect(gravar).toBeDisabled()
  await page.getByLabel('O que ela entrega').fill('bolo de 2kg com 3 dias de antecedência')
  await expect(gravar).toBeEnabled()
  await gravar.click()

  await expect(page.getByText('Versão nova do plano gravada.')).toBeVisible()
  await expect(page.getByRole('heading', { level: 3, name: 'Versão 2 do plano' })).toBeVisible()
  // A versão 1 NÃO sumiu: revisar cria versão nova, e não edita no lugar.
  await page.getByText('Versões anteriores').click()
  await expect(page.getByRole('heading', { level: 4, name: 'Versão 1 do plano' })).toBeVisible()
  await expect(page.getByText('bolo de 1kg com 2 dias de antecedência')).toBeVisible()

  // O que foi gravado sobrevive a um RECARREGAMENTO: veio do servidor, e não
  // do estado da tela.
  await page.reload()
  await page.getByRole('button', { name: 'Abrir' }).click()
  await expect(page.getByRole('heading', { level: 3, name: 'Versão 2 do plano' })).toBeVisible()

  await page.getByRole('button', { name: 'Arquivar a empresa' }).click()
  await expect(page.getByText('Empresa arquivada.')).toBeVisible()
  await expect(page.getByText('Você ainda não cadastrou nenhuma empresa.')).toBeVisible()
})

/**
 * `BUS-02` — a tarefa criada PARA a empresa, com o plano dela dentro.
 *
 * Esta é a fatia que fecha `empresa → objetivo → plano → tarefa`. O que ela
 * prova, e que nenhum teste de unidade alcança: a tarefa que nasce daqui é uma
 * tarefa DE VERDADE — criada pelo serviço de produção do prompt-to-app, com a
 * mesma identidade de envio e a mesma contagem de tentativas — e o plano da
 * empresa entra no briefing dela.
 */
test('cria uma tarefa para a empresa, com o plano dentro, e ela aparece na empresa', async ({ context, page }) => {
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: 'http://studio.dz23.localhost:4179' },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: 'http://studio.dz23.localhost:4179' },
  ])
  await page.request.get('http://127.0.0.1:4179/e2e/reset-business')
  await page.goto('/studio/empresas')
  await page.getByRole('button', { name: 'Cadastrar empresa' }).click()
  await page.getByLabel('Nome da empresa').fill('Bolos da Ana')
  await page.getByLabel('O que a empresa se propõe a fazer').fill('vender bolos caseiros por encomenda no bairro')
  await page.getByLabel('Para quem').fill('moradores do bairro')
  await page.getByLabel('O que ela não faz').fill('não entrega fora do bairro')
  await page.getByRole('button', { name: 'Salvar empresa' }).click()
  await expect(page.getByRole('heading', { level: 3, name: 'Versão 1 do plano' })).toBeVisible()

  // A empresa DIZ que não tem tarefa, que é diferente de não mostrar nada.
  await expect(page.getByText('Nenhuma tarefa foi criada para esta empresa ainda.')).toBeVisible()

  await page.getByRole('button', { name: 'Criar uma tarefa para esta empresa' }).click()
  const criar = page.getByRole('button', { name: 'Criar a tarefa' })
  await expect(criar).toBeDisabled()
  await expect(page.getByText('Escreva o que você quer que seja criado')).toBeVisible()
  await page.getByLabel('O que você quer que seja criado').fill('uma página para receber encomendas')
  await page.getByLabel('Tipo de aplicativo').selectOption('landing-page')
  await expect(criar).toBeEnabled()
  await criar.click()

  await expect(page.getByText('Tarefa criada com o plano da empresa dentro.')).toBeVisible()
  // O vínculo guarda a VERSÃO do plano: sem ela, a pergunta "com base em quê
  // esta tarefa foi feita?" perde a resposta na primeira revisão.
  await expect(page.getByText('Criada com a versão 1 do plano')).toBeVisible()
  // O rótulo do link é o NOME da tarefa, e não a palavra "Abrir": com três
  // tarefas, três linhas iguais não dizem qual é qual.
  //
  // A busca é ESCOPADA à seção porque o mesmo nome também aparece no trilho de
  // tarefas do produto. NÃO se afirma nada sobre o trilho aqui: ele mostra as
  // tarefas mais recentes com um teto, e quantas cabem depende de quantas os
  // outros casos criaram — seria a mesma dependência de ordem que já custou uma
  // CI. A prova de que a tarefa é de verdade está abaixo: ela abre na conversa
  // do produto, com o briefing dentro.
  const secao = page.getByLabel('Tarefas desta empresa')
  const abrir = secao.getByRole('link', { name: 'uma página para receber encomendas' })
  await expect(abrir).toHaveAttribute('href', /\/studio\/\?projeto=/u)

  // `BUS-03`: a EVIDÊNCIA da tarefa volta para a empresa — lida de quem já a
  // guarda, e não de uma cópia gravada aqui.
  /*
    DUAS versões do pacote, e a evidência lista as duas.

    Antes havia uma só, e a asserção era `toBeVisible()`. Com a fatia de
    VERSÕES o servidor de teste passou a devolver dois pacotes por tarefa — e a
    contagem é mais forte que a visibilidade: ela prova que a evidência não
    esconde a versão antiga nem mostra a mesma duas vezes.
  */
  await expect(secao.getByRole('link', { name: 'Baixar prototipo.zip' })).toHaveCount(2)
  await expect(secao.getByRole('link', { name: 'Baixar prototipo.zip' }).first()).toBeVisible()
  await expect(page.getByText('2 pacotes produzidos por esta empresa.')).toBeVisible()


  // E a tarefa é uma tarefa DE VERDADE: ela abre na conversa do produto, e o
  // briefing dela carrega o plano da empresa — o que faz o vínculo valer algo.
  await abrir.click()
  await expect(page.getByLabel('Conversa desta tarefa')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('moradores do bairro').first()).toBeVisible()
  await expect(page.getByText('não entrega fora do bairro').first()).toBeVisible()

  // Depois de RECARREGAR a tela da empresa, a tarefa continua lá: ela veio do
  // servidor, e não do estado da tela.
  await page.goto('/studio/empresas')
  await page.getByRole('button', { name: 'Abrir', exact: true }).click()
  await expect(page.getByLabel('Tarefas desta empresa').getByRole('link', { name: 'uma página para receber encomendas' })).toHaveCount(1)
})

/**
 * `V7-C` — os dois últimos envios que faltavam ter identidade de intenção.
 *
 * Eles não duplicavam efeito VISÍVEL, e é por isso que ficaram por último — e
 * também por que era preciso fechá-los: "não duplica" era argumento, não prova.
 * O que a RESPOSTA do questionário duplicava era CUSTO, porque com "recomendar"
 * ela chama modelo; o que o PEDIDO DE ALTERAÇÃO devolvia era um erro de
 * repetição para quem só tinha reenviado a mesma intenção.
 */
test('responder e pedir alteração no plano: o reenvio não duplica nem devolve erro', async ({ context, page }) => {
  const origin = 'http://studio.dz23.localhost:4179'
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
  await context.addInitScript(() => { window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e') })
  await page.goto('/studio/')
  await page.getByRole('button', { name: 'Página de apresentação' }).click()
  await page.getByRole('button', { name: 'Continuar' }).click()

  /*
    ESPERA o endereço trazer o projeto antes de ler dele.

    Sem isto o caso ficava FLAKY na suíte inteira e passava sozinho: quando a
    navegação ainda não tinha atualizado o endereço, `projeto` saía `null`, a
    rota virava `/projects/null/intake/answer` e o 404 acusava a leitura, e não
    o comportamento sob teste. `expect.poll` é a espera; a asserção de que o
    identificador existe é o que transforma o resto num erro legível.
  */
  await expect.poll(() => page.evaluate(() => new URL(window.location.href).searchParams.get('projeto'))).not.toBeNull()
  const projeto = await page.evaluate(() => new URL(window.location.href).searchParams.get('projeto'))
  expect(projeto).not.toBeNull()
  const postar = async (rota: string, corpo: Record<string, unknown>) => page.evaluate(async ([id, caminho, body]) => {
    const resposta = await fetch(`/api/studio/apps/projects/${String(id)}/${String(caminho)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-dz23-csrf': 'csrf-e2e' },
      body: JSON.stringify(body),
    })
    return resposta.status
  }, [projeto, rota, corpo] as const)

  // A RESPOSTA do questionário, mandada duas vezes com a mesma intenção.
  const resposta = { answer: 'moradores do bairro', recommend: false, request_key: 'chave-resposta-e2e-01' }
  expect(await postar('intake/answer', resposta)).toBe(200)
  expect(await postar('intake/answer', resposta)).toBe(200)

  await answerIntake(page, INTAKE_ANSWERS)
  await page.getByRole('button', { name: 'Montar meu plano' }).click()
  await expect(page.getByText('Plano proposto', { exact: false })).toBeVisible({ timeout: 20_000 })

  // O PEDIDO DE ALTERAÇÃO. O segundo devolvia 409 de repetição antes desta
  // fatia; agora devolve o MESMO plano, que é o que aconteceu de verdade.
  const mudanca = { reason: 'o botão precisa ficar verde', request_key: 'chave-mudanca-e2e-01' }
  expect(await postar('plan/change', mudanca)).toBe(200)
  expect(await postar('plan/change', mudanca)).toBe(200)

  // E a guarda de estado NÃO foi enfraquecida: outra intenção, no mesmo estado,
  // continua sendo recusada pelo que o plano é agora.
  expect(await postar('plan/change', { reason: 'outra coisa qualquer', request_key: 'chave-mudanca-e2e-02' })).toBe(409)

  /*
    E o que ficou GUARDADO é uma alteração pedida, com este texto.

    A conferência é no servidor, e não no que a tela desenhou: o que importa
    depois de a resposta se perder é o estado que sobreviveu, e uma asserção
    sobre pixels responderia outra pergunta.
  */
  const guardado = await page.evaluate(async id => {
    const resposta = await fetch(`/api/studio/apps/projects/${String(id)}`, { credentials: 'same-origin' })
    return await resposta.json() as { plan?: { status?: string; change_request?: string; revision?: number } }
  }, projeto)
  expect(guardado.plan?.status).toBe('CHANGE_REQUESTED')
  expect(guardado.plan?.change_request).toBe('o botão precisa ficar verde')
})


/**
 * O ATALHO DE ENVIO — a ação nova que esta fatia entrega.
 *
 * A seção "Atalhos de teclado" das Preferências era uma pendência que dizia não
 * haver atalho nenhum. Havia `Esc` em três lugares, e nenhum lugar que o
 * dissesse — mas listar os três não fecharia o requisito. O que faltava de
 * verdade era enviar sem tirar a mão do teclado, e é isto que este caso prova:
 * a tarefa NASCE do atalho, e não do clique.
 */
test('Ctrl+Enter envia do compositor, e Enter sozinho continua quebrando linha', async ({ context, page }) => {
  const origin = 'http://studio.dz23.localhost:4179'
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
  await context.addInitScript(() => { window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e') })
  await page.goto('/studio/')
  await page.getByRole('button', { name: 'Página de apresentação' }).click()

  const compositor = page.getByLabel('Descreva o aplicativo que você quer')
  await compositor.fill('uma página para a clínica receber contatos')

  /*
    ENTER SOZINHO não envia: ele quebra linha.

    Esta metade do caso é a que protege quem escreve dois parágrafos. Sem ela, a
    prova do atalho seria só "o atalho funciona", e o defeito perigoso —
    sequestrar o Enter — passaria sem ninguém ver.
  */
  await compositor.press('Enter')
  await compositor.type('e mostrar os horários')
  await expect(compositor).toHaveValue(/contatos\n?e mostrar os horários/u)
  // Nenhuma tarefa nasceu: continuamos na home, com o compositor aberto.
  await expect(page.getByRole('button', { name: 'Continuar' })).toBeVisible()

  // E o atalho ENVIA: a tarefa nasce daqui.
  await compositor.press('Control+Enter')
  await expect(page.getByLabel('Conversa desta tarefa')).toBeVisible({ timeout: 20_000 })
  await expect(page).toHaveURL(/\?projeto=/u)
})


/**
 * LEVAR CONSIGO o que o espaço guardou — a operação de "Controles de dados".
 *
 * O que este caso prova é o que só existe no produto montado: a rota responde
 * como ANEXO, o arquivo tem a tarefa que acabou de nascer dentro, e ele carrega
 * o carimbo de quem levou e de qual escopo.
 */
test('dá para baixar tudo o que é meu, e o arquivo tem a tarefa dentro', async ({ context, page }) => {
  const origin = 'http://studio.dz23.localhost:4179'
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
  await context.addInitScript(() => { window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e') })
  await page.goto('/studio/')
  await page.getByRole('button', { name: 'Página de apresentação' }).click()
  await page.getByRole('button', { name: 'Continuar' }).click()
  await expect(page.getByLabel('Conversa desta tarefa')).toBeVisible({ timeout: 20_000 })

  // O link das Preferências aponta para a rota, e baixa em vez de abrir.
  const menu = page.getByRole('button', { name: 'Abrir o menu', exact: true })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('button', { name: 'Preferências', exact: true }).click()
  const modal = page.getByRole('dialog', { name: 'Preferências' })
  await modal.getByRole('button', { name: 'Controles de dados', exact: true }).click()
  const baixar = modal.getByRole('link', { name: 'Baixar tudo o que é meu' })
  await expect(baixar).toHaveAttribute('href', '/api/studio/apps/export')
  await expect(baixar).toHaveAttribute('download', '')

  // E o que a rota devolve é o espaço inteiro, como ANEXO.
  const resposta = await page.evaluate(async () => {
    const r = await fetch('/api/studio/apps/export', { credentials: 'same-origin' })
    return { tipo: r.headers.get('content-disposition'), corpo: await r.json() as Record<string, unknown> }
  })
  expect(resposta.tipo).toContain('attachment')
  expect(resposta.tipo).toContain('.json')
  const corpo = resposta.corpo as { org_id: string; exported_by: string; projects: { project: { name: string } }[] }
  expect(corpo.org_id).toBeTruthy()
  expect(corpo.exported_by).toBeTruthy()
  // A tarefa que acabou de nascer está lá dentro.
  expect(corpo.projects.length).toBeGreaterThan(0)
})

test('cadastra a oferta da empresa, vê a margem dizer o que não sabe, e aprova', async ({ context, page }) => {
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: 'http://studio.dz23.localhost:4179' },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: 'http://studio.dz23.localhost:4179' },
  ])
  // Pré-condição EXPLÍCITA, pela lição da causa de CI número sete: o
  // armazenamento deste servidor é um só para a execução inteira do Playwright.
  await page.request.get('http://127.0.0.1:4179/e2e/reset-business')
  await page.goto('/studio/empresas')
  await page.getByRole('button', { name: 'Cadastrar empresa' }).click()
  await page.getByLabel('Nome da empresa').fill('Bolos da Ana')
  await page.getByLabel('O que a empresa se propõe a fazer').fill('vender bolos caseiros por encomenda no bairro')
  await page.getByLabel('Para quem').fill('moradores do bairro')
  await page.getByLabel('O que ela entrega').fill('bolo de 1kg com 2 dias de antecedência')
  await page.getByRole('button', { name: 'Salvar empresa' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Bolos da Ana' })).toBeVisible()

  // A empresa nasce SEM catálogo, e a tela diz isso em vez de ficar em branco.
  await expect(page.getByText('Esta empresa ainda não tem oferta cadastrada.')).toBeVisible()

  await page.getByRole('button', { name: 'Cadastrar oferta' }).click()
  await page.getByLabel('Nome da oferta').fill('Bolo de aniversário')
  await page.getByLabel('O que a empresa entrega').fill('Um bolo de dois quilos, decorado, entregue no endereço.')
  await page.getByLabel('Para quem', { exact: true }).last().fill('Famílias do bairro')

  // PRIMEIRO sem preço e sem custo: a margem tem de dizer que NÃO SABE, e a
  // sugestão tem de dizer que não há de onde sugerir. É o caso que separa
  // "não sei" de "lucro puro", e é o coração do aceite de BUS-03.
  await expect(page.getByText('Sem custo com valor declarado, não há de onde sugerir.')).toBeVisible()
  await page.getByRole('button', { name: 'Salvar' }).last().click()
  await expect(page.getByText('Preço ainda não decidido')).toBeVisible()
  await expect(page.getByText('Não dá para estimar: falta o preço ou não há custo declarado.')).toBeVisible()
  // Sem preço, o botão de aprovar NÃO existe, e a tela diz o que falta.
  await expect(page.getByRole('button', { name: 'Aprovar esta versão' })).toHaveCount(0)
  await expect(page.getByText('Escreva o preço antes de aprovar.')).toBeVisible()

  // Agora a revisão: preço, capacidade, condição e DOIS custos, um deles sem
  // valor. A margem passa a ser um TETO, e nomeia o custo que falta saber.
  await page.getByRole('button', { name: 'Revisar esta oferta' }).click()
  await page.getByLabel('Preço', { exact: true }).fill('200')
  await page.getByLabel('Quanto consegue entregar').fill('4')
  await page.getByLabel('Condições').fill('Encomenda com três dias de antecedência')
  await page.getByRole('button', { name: 'Adicionar custo' }).click()
  await page.getByLabel('Custo', { exact: true }).fill('Ingredientes')
  await page.getByLabel('Valor', { exact: true }).fill('60')
  await page.getByRole('button', { name: 'Adicionar custo' }).click()
  await page.getByLabel('Custo', { exact: true }).last().fill('Frete')
  // O segundo custo fica SEM valor de propósito: vazio não é zero.
  await page.getByRole('button', { name: 'Salvar' }).last().click()

  await expect(page.getByText('Versão 2')).toBeVisible()
  await expect(page.getByText('É um teto, e não uma estimativa')).toBeVisible()
  await expect(page.getByText('Sem valor: Frete')).toBeVisible()

  // Aprovar registra a decisão NESTA versão, e a tela passa a dizer "Aprovada".
  await page.getByRole('button', { name: 'Aprovar esta versão' }).click()
  await expect(page.getByText('Aprovada')).toBeVisible()

  // E a revisão de uma oferta APROVADA nasce em rascunho de novo: herdar a
  // aprovação faria condições que ninguém leu virarem "condições aprovadas".
  await page.getByRole('button', { name: 'Revisar esta oferta' }).click()
  await page.getByLabel('Preço', { exact: true }).fill('240')
  await page.getByRole('button', { name: 'Salvar' }).last().click()
  await expect(page.getByText('Versão 3')).toBeVisible()
  await expect(page.getByText('Rascunho')).toBeVisible()
})

/*
  ESTE caso — e só ele — roda com o navegador em INGLÊS.

  A negociação BCP 47 não é provável com o navegador em português: seria o
  mesmo idioma dos dois lados, e o teste passaria sem exercitar nada. Declarar
  o idioma aqui é o que torna o primeiro degrau da precedência verificável.
*/
test.describe(() => {
  test.use({ locale: 'en-US' })

test('troca o idioma da interface, e a escolha sobrevive ao recarregamento sem mexer no rascunho', async ({ context, page }) => {
  const origin = 'http://studio.dz23.localhost:4179'
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
  await page.goto('/studio/')

  /*
    A NEGOCIAÇÃO do navegador, provada antes de qualquer escolha.

    O Chromium do Playwright roda em `en-US`, e é por isso que este caso começa
    em inglês: sem escolha guardada, o produto atende o idioma que a pessoa
    configurou no navegador. Escrevi este caso esperando português e ele
    reprovou — a expectativa é que estava errada, não o produto, e é este
    parágrafo que impede a próxima pessoa de "consertar" a negociação.
  */
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('link', { name: 'New task' })).toBeVisible()
  /*
    O NOME ACESSÍVEL DO LOGOTIPO, que é o defeito que a revisão de 18/09/2026
    achou lendo o código: ele saía `FRIGG: ir para a tela inicial` em qualquer
    idioma, porque vinha de uma função com a frase fixa dentro.

    Ele é conferido AQUI, por papel e nome acessível, e não por um seletor de
    classe: quem lê este rótulo é um leitor de tela, e o que o leitor de tela usa
    é exatamente o que `getByRole` resolve. Um teste que procurasse a string no
    arquivo passaria com o defeito de volta.
  */
  await expect(page.getByRole('link', { name: 'FRIGG: go to the home screen' })).toBeVisible()

  /*
    O RASCUNHO fica escrito ANTES da troca.

    O adendo é explícito: trocar de idioma não pode criar tarefa, cancelar
    execução, refazer login nem perder rascunho. Escrever antes e conferir
    depois é a única forma de provar isso — e não a ausência de um erro.
  */
  const rascunho = 'uma loja para vender bolos no bairro'
  await page.getByRole('textbox').first().fill(rascunho)

  // A ESCOLHA EXPLÍCITA vence a negociação — é o primeiro degrau da precedência.
  await page.getByRole('button', { name: 'Preferences' }).click()
  await page.getByRole('button', { name: 'Language' }).click()
  await page.getByRole('radio', { name: 'Português (Brasil)' }).check()

  // A navegação e a tela de Preferências trocam na hora, sem recarregar.
  await expect(page.getByRole('link', { name: 'Nova tarefa' })).toBeVisible()
  await expect(page.getByText('Idioma da interface')).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR')
  // E a tela DIZ que a cobertura é parcial, em vez de fingir que tudo traduziu.
  await expect(page.getByText('as demais telas', { exact: false })).toBeVisible()

  // E o rótulo do logotipo acompanhou a troca, junto com o resto da navegação.
  await expect(page.getByRole('link', { name: 'FRIGG: ir para a tela inicial' })).toBeVisible()

  await page.getByRole('button', { name: 'Fechar as preferências' }).click()
  // O rascunho continua inteiro: a troca é de apresentação, e só.
  await expect(page.getByRole('textbox').first()).toHaveValue(rascunho)

  /*
    A escolha SOBREVIVE ao recarregamento, e continua vencendo a negociação do
    navegador — que continua dizendo inglês. É o que separa um seletor de um
    botão que muda a tela e esquece.
  */
  await page.reload()
  await expect(page.getByRole('link', { name: 'Nova tarefa' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR')

  // E o espanhol também é um idioma de verdade, e não um arquivo no disco.
  await page.getByRole('button', { name: 'Preferências' }).click()
  await page.getByRole('button', { name: 'Idioma' }).click()
  await page.getByRole('radio', { name: 'Español' }).check()
  await expect(page.getByRole('link', { name: 'Nueva tarea' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'FRIGG: ir a la pantalla de inicio' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'es')
})
})

test.describe('reenvio de edição após perda da resposta', () => {
  test.use({ serviceWorkers: 'block' })

  test('preserva a edição e reusa o recibo quando a resposta gravada se perde', async ({ context, page }) => {
    const origin = 'http://studio.dz23.localhost:4179'
    await context.addCookies([
      { name: 'dz23_studio_session', value: 'e2e', url: origin },
      { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
    ])
    await context.addInitScript(() => { window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e') })
    await page.goto('/studio/')
    await page.getByRole('button', { name: 'Página de apresentação' }).click()
    await page.getByRole('button', { name: 'Continuar' }).click()
    await answerIntake(page, INTAKE_ANSWERS)
    await page.getByRole('button', { name: 'Montar meu plano' }).click()
    const card = page.locator('.plan-list .task-card').first()
    await card.getByRole('button', { name: 'Editar esta parte' }).click()
    await page.getByLabel('Nome desta parte').fill('Minha edição preservada')
    const bodies: Array<{ request_key: string; base_revision: number }> = []
    const results: Array<{ plan: { plan_id: string; revision: number } }> = []
    await page.route('**/plan/edit', async route => {
      bodies.push(route.request().postDataJSON())
      const target = new URL(route.request().url())
      const host = target.host
      target.hostname = '127.0.0.1'
      const response = await route.fetch({ url: target.href, headers: { ...route.request().headers(), host } })
      expect(response.status()).toBe(200)
      results.push(await response.json())
      if (bodies.length === 1) await route.abort('failed')
      else await route.fulfill({ response })
    })
    await page.getByRole('button', { name: 'Guardar minha alteração' }).click()
    await expect.poll(() => bodies.length).toBe(1)
    await expect(page.getByRole('button', { name: 'Guardar minha alteração' })).toBeEnabled()
    await expect(page.getByLabel('Nome desta parte')).toHaveValue('Minha edição preservada')
    await page.screenshot({ path: test.info().outputPath('plan-retry.png'), fullPage: true })
    const projectId = new URL(page.url()).searchParams.get('projeto')!
    const detailsRoute = `**/projects/${projectId}`
    await page.route(detailsRoute, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Não foi possível atualizar os detalhes da tarefa.' }) }))
    await page.getByRole('button', { name: 'Guardar minha alteração' }).click()
    await expect(card.locator('h2')).toHaveText('Minha edição preservada')
    expect(bodies).toHaveLength(2)
    expect(bodies[0]!.request_key).toMatch(/^[a-zA-Z0-9_-]{16,128}$/u)
    expect(bodies[1]).toEqual(bodies[0])
    expect(results[1]!.plan.plan_id).toBe(results[0]!.plan.plan_id)
    expect(results[1]!.plan.revision).toBe(results[0]!.plan.revision)
    await expect(page.getByText('Não foi possível atualizar os detalhes da tarefa.', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Nome desta parte')).toHaveCount(0)
    await page.unroute(detailsRoute)
    await page.reload()
    await expect(page.locator('.plan-list .task-card h2').first()).toHaveText('Minha edição preservada')
    const additions: Array<{ request_key: string }> = []
    const additionResults: Array<{ plan: { plan_id: string; revision: number } }> = []
    await page.route('**/plan/slice', async route => {
      additions.push(route.request().postDataJSON())
      const target = new URL(route.request().url()); const host = target.host
      target.hostname = '127.0.0.1'
      const headers: Record<string, string> = { ...route.request().headers(), host }
      // Aguarda a rota concluir antes de descartar sua resposta, sem o polling do cliente.
      delete headers['x-dz23-espera']
      const response = await route.fetch({ url: target.href, headers })
      expect(response.status()).toBe(200)
      additionResults.push(await response.json())
      if (additions.length === 1) await route.abort('failed')
      else await route.fulfill({ response })
    })
    const addition = page.getByLabel('Escreva o que falta, com suas palavras')
    await addition.fill('Falta o endereço de atendimento')
    await page.getByRole('button', { name: 'Acrescentar esta etapa' }).click()
    await expect.poll(() => additions.length).toBe(1)
    await expect(page.getByRole('button', { name: 'Acrescentar esta etapa' })).toBeEnabled()
    await expect(addition).toHaveValue('Falta o endereço de atendimento')
    await page.getByRole('button', { name: 'Acrescentar esta etapa' }).click()
    await expect(page.locator('.plan-list .task-card')).toHaveCount(3)
    expect(additions).toHaveLength(2)
    expect(additions[0]!.request_key).toMatch(/^[a-zA-Z0-9_-]{16,128}$/u)
    expect(additions[1]).toEqual(additions[0])
    expect(additionResults[1]).toEqual(additionResults[0])
    await page.reload()
    await expect(page.locator('.plan-list .task-card')).toHaveCount(3)
  })

})
