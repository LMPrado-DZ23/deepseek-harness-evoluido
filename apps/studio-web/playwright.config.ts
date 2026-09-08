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
  // `mobile-nav.spec.ts` e `team-panel.spec.ts` rodam nos três tamanhos. Rodar
  // a suíte inteira três vezes triplicaria o tempo da CI para reprovar as
  // mesmas coisas; o que muda com o tamanho da tela é a navegação e a única
  // tela com hierarquia visual própria - a árvore recuada do progresso, cujo
  // recuo e cujo aviso de consumo parcial precisam continuar legíveis e
  // acessíveis num telefone.
  projects: [
    { name: 'mesa', use: { ...devices['Desktop Chrome'] } },
    { name: 'tablet', testMatch: /(mobile-nav|team-panel)\.spec\.ts$/u, use: { ...devices['Desktop Chrome'], viewport: { width: 800, height: 1180 }, hasTouch: true } },
    { name: 'celular', testMatch: /(mobile-nav|team-panel)\.spec\.ts$/u, use: { ...devices['Pixel 5'] } },
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
