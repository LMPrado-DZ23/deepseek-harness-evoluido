import { defineConfig, devices } from '@playwright/test'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const chromiumPath = process.env.DZ23_CHROMIUM_PATH?.trim() || undefined
if (chromiumPath !== undefined && (!isAbsolute(chromiumPath) || !existsSync(chromiumPath))) {
  throw new Error('DZ23_CHROMIUM_PATH deve apontar para um executável Chromium absoluto e existente.')
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
    { name: 'mesa', use: { ...devices['Desktop Chrome'] } },
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
    ...(chromiumPath === undefined ? {} : { launchOptions: { executablePath: chromiumPath } }),
  },
  webServer: {
    command: 'node ../../node_modules/tsx/dist/cli.mjs tests/server.ts', url: 'http://127.0.0.1:4179/healthz',
    reuseExistingServer: false, timeout: 30_000,
  },
})
