import { defineConfig, devices } from '@playwright/test'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

/*
  O NAVEGADOR DA MÁQUINA LOCAL TEM DE SER O DA CI, e esta conferência existe
  porque a diferença entre os dois já custou cinco entregas.

  A CI roda `playwright install chromium`, que instala a compilação que o
  `@playwright/test` desta árvore fixa. A máquina de quem desenvolve tinha
  outra compilação à mão e a forçava por `DZ23_CHROMIUM_PATH` — mais nova, e
  mais permissiva: ela aceita o prefixo `__Host-` sobre http e a da CI recusa.
  O teste de cookie de sessão passava aqui e reprovava lá, e o verde anunciado
  era o da máquina errada.

  Forçar outro executável continua permitido — é assim que se MEDE a diferença
  entre navegadores, como foi medida agora. O que não é permitido é fazer isso
  em silêncio: o caminho tem de trazer o número da compilação fixada, ou dizer
  em voz alta que está medindo outra coisa.
*/
const exigir = createRequire(import.meta.url)
const RAIZ_PLAYWRIGHT = exigir.resolve('playwright-core').replace(/playwright-core[\\/].*$/u, 'playwright-core/')
const REVISAO_FIXADA = (JSON.parse(readFileSync(`${RAIZ_PLAYWRIGHT}browsers.json`, 'utf8')) as {
  browsers: readonly { readonly name: string, readonly revision: string, readonly browserVersion: string }[]
}).browsers.find(navegador => navegador.name === 'chromium')!

const chromiumPath = process.env.DZ23_CHROMIUM_PATH?.trim() || undefined
if (chromiumPath !== undefined && (!isAbsolute(chromiumPath) || !existsSync(chromiumPath))) {
  throw new Error('DZ23_CHROMIUM_PATH deve apontar para um executável Chromium absoluto e existente.')
}
if (chromiumPath !== undefined && !chromiumPath.includes(`chromium-${REVISAO_FIXADA.revision}`) && process.env.DZ23_CHROMIUM_OUTRA_COMPILACAO !== 'sim') {
  throw new Error(
    `DZ23_CHROMIUM_PATH aponta para uma compilação diferente da fixada (chromium-${REVISAO_FIXADA.revision}, ${REVISAO_FIXADA.browserVersion}), `
    + 'que é a que a CI instala. Rodar aqui um navegador que a CI não roda produz verde da máquina errada. '
    + 'Para medir de propósito a diferença entre navegadores, declare DZ23_CHROMIUM_OUTRA_COMPILACAO=sim.',
  )
}

export default defineConfig({
  testDir: './tests', timeout: 60_000, workers: 1,
  // Havia UM Chromium de mesa e nada mais: celular e tablet não eram testados
  // em lugar nenhum, e foi por isso que a barra lateral pôde sumir abaixo de
  // 820px com o botão de menu mudo sem nenhum teste reclamar.
  //
  // `mobile-nav.spec.ts`, `team-panel.spec.ts` e `mission.spec.ts` rodam nos
  // três tamanhos. Rodar
  // a suíte inteira três vezes triplicaria o tempo da CI para reprovar as
  // mesmas coisas; o que muda com o tamanho da tela é a navegação e a única
  // tela com hierarquia visual própria - a árvore recuada do progresso, cujo
  // recuo e cujo aviso de consumo parcial precisam continuar legíveis e
  // acessíveis num telefone.
  projects: [
    { name: 'mesa', testIgnore: /capturas\.spec\.ts$/u, use: { ...devices['Desktop Chrome'] } },
    /*
      A GRAVAÇÃO da navegação, exigida pela decisão visual: "grave uma
      navegação: home → pedido → conversa → continuar pedido → abrir/fechar
      artefato ou preview → habilidades → plugins → biblioteca → preferências".

      Ela é um projeto separado, e não uma opção do `mesa`, porque gravar vídeo
      de 120 testes gastaria minutos e disco por nada. Aqui roda UM teste, o que
      percorre a jornada inteira, e o vídeo sai do mesmo build e do mesmo
      servidor de teste que a suíte usa — que é o que impede reaproveitar
      gravação antiga como prova de versão nova.
    */
    { name: 'gravacao', testMatch: /capturas\.spec\.ts$/u, use: { ...devices['Desktop Chrome'], video: { mode: 'on', size: { width: 1280, height: 800 } } } },
    { name: 'tablet', testMatch: /(mobile-nav|team-panel|accessibility|mission)\.spec\.ts$/u, use: { ...devices['Desktop Chrome'], viewport: { width: 800, height: 1180 }, hasTouch: true } },
    { name: 'celular', testMatch: /(mobile-nav|team-panel|accessibility|mission)\.spec\.ts$/u, use: { ...devices['Pixel 5'] } },
    // 900px: a FAIXA CEGA. O layout vira coluna abaixo de 820px e o grid de duas
    // colunas precisava de 948px para caber (480 + 360 + 40 de gap + 68 de
    // padding). Entre um e outro o corpo rolava para os lados, e nenhum tamanho
    // testado caía ali: "tablet" usa 800px, 21px do lado seguro. É onde vive
    // tablet 8-9" em paisagem e janela de navegador lado a lado.
    { name: 'faixa-estreita', testMatch: /(mobile-nav|team-panel|accessibility|mission|overflow)\.spec\.ts$/u, use: { ...devices['Desktop Chrome'], viewport: { width: 900, height: 800 } } },
  ],
  outputDir: process.env.CI === 'true' ? '/tmp/dz23-studio-web-test-results' : './test-results',
  use: {
    baseURL: 'http://studio.dz23.localhost:4179', trace: 'retain-on-failure',
    /*
      O IDIOMA DO NAVEGADOR é DECLARADO, e não herdado de quem roda a suíte.

      Até esta linha existir, a suíte dependia em silêncio do idioma da máquina:
      o Chromium do Playwright anuncia `en-US`, e enquanto o produto falava só
      português isso não tinha efeito nenhum. No dia em que ele passou a
      NEGOCIAR o idioma, dezenas de casos que afirmam rótulos em português
      passaram a reprovar — e a causa não era o produto, era uma dependência
      ambiental que nunca tinha sido escrita.

      `pt-BR` porque é o idioma dos casos existentes e do público do produto.
      Quem quiser provar a negociação declara outro com `test.use`, que é o que
      o caso de idiomas faz.
    */
    locale: 'pt-BR',
    ...(chromiumPath === undefined ? {} : { launchOptions: { executablePath: chromiumPath } }),
  },
  webServer: {
    // O loader executa o mesmo servidor TypeScript sem o socket IPC privado
    // do lançador tsx, indisponível em alguns ambientes de teste restritos.
    command: 'node --import tsx tests/server.ts', url: 'http://127.0.0.1:4179/healthz',
    reuseExistingServer: false, timeout: 30_000,
  },
})
