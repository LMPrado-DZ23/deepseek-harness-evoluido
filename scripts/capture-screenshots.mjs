/**
 * As imagens do README, capturadas do produto REAL.
 *
 * Existe porque um README de projeto aberto sem imagem obriga quem chega a
 * instalar antes de saber o que é — e porque imagem desenhada à mão mente: ela
 * mostra o produto que a gente gostaria de ter, não o que o repositório
 * entrega. Estas saem do mesmo servidor de teste que o e2e usa, percorrendo a
 * jornada de verdade.
 *
 * Uso: node scripts/capture-screenshots.mjs [--out docs/images]
 *
 * Precisa do `pnpm build` feito antes: a interface servida é `dist`, e um
 * `dist` velho produziria imagens de uma versão que não existe mais.
 */
import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outIndex = process.argv.indexOf('--out')
const outDirectory = resolve(root, outIndex === -1 ? 'docs/images' : process.argv[outIndex + 1])
const origin = 'http://studio.dz23.localhost:4179'
const executablePath = process.env.DZ23_CHROMIUM_PATH?.trim()

if (executablePath === undefined || executablePath === '' || !existsSync(executablePath)) {
  process.stderr.write('DZ23_CHROMIUM_PATH precisa apontar para um Chromium existente.\n')
  process.exit(1)
}

const dist = resolve(root, 'apps/studio-web/dist/index.html')
if (!existsSync(dist)) {
  process.stderr.write('apps/studio-web/dist não existe: rode `pnpm build` antes.\n')
  process.exit(1)
}

/** Já existe um servidor de teste de pé? Então usamos o dele. */
async function serverAlive() {
  try { return (await fetch('http://127.0.0.1:4179/healthz')).ok } catch { return false }
}

// Subir um segundo servidor na mesma porta falha em silêncio e deixa o navegador
// falando com o primeiro - que pode estar servindo um `dist` antigo. Reusar o
// que já está de pé é o comportamento honesto.
const reuse = await serverAlive()
const server = reuse ? undefined : spawn(process.execPath, [resolve(root, 'node_modules/tsx/dist/cli.mjs'), 'tests/server.ts'], {
  cwd: resolve(root, 'apps/studio-web'), stdio: ['ignore', 'ignore', 'inherit'],
})
const stopServer = () => { server?.kill('SIGTERM') }
process.once('exit', stopServer)

/** Espera o servidor de teste responder, em vez de dormir um tempo fixo. */
async function waitForServer(attempts = 60) {
  for (let index = 0; index < attempts; index++) {
    try {
      const response = await fetch('http://127.0.0.1:4179/healthz')
      if (response.ok) return
    } catch { /* ainda subindo */ }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('o servidor de teste não respondeu em /healthz')
}

const shots = []

async function shot(page, name) {
  const path = resolve(outDirectory, `${name}.png`)
  await page.screenshot({ path, animations: 'disabled' })
  shots.push(name)
}

try {
  await waitForServer()
  await rm(outDirectory, { recursive: true, force: true })
  await mkdir(outDirectory, { recursive: true })
  const browser = await chromium.launch({ executablePath })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
  await context.addInitScript(() => { window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e') })
  const page = await context.newPage()

  // 1. A primeira tela: a ideia, com as palavras da pessoa.
  await page.goto(`${origin}/studio/`)
  await page.getByRole('textbox').first().fill('quero uma página para apresentar minha clínica e receber contatos')
  await page.waitForTimeout(300)
  await shot(page, '01-ideia')

  // 2. As perguntas, uma por vez, sem termo técnico.
  await page.getByRole('button', { name: 'Continuar' }).click()
  await page.getByLabel('Sua resposta').waitFor()
  await shot(page, '02-perguntas')

  for (const answer of ['Clientes locais', 'Conhecer os serviços', 'Serviços e contato']) {
    await page.getByLabel('Sua resposta').fill(answer)
    await page.getByRole('button', { name: 'Responder e continuar' }).click()
  }

  // 3. O plano, que a pessoa aprova ou muda antes de qualquer criação.
  await page.getByRole('button', { name: 'Montar meu plano' }).click()
  await page.getByRole('button', { name: 'Aprovar este plano' }).waitFor()
  await shot(page, '03-plano')

  // 4. O resultado: critérios conferidos, relato e pontos de retorno.
  await page.getByRole('button', { name: 'Aprovar este plano' }).click()
  await page.getByRole('button', { name: 'Iniciar criação' }).click()
  await page.getByRole('button', { name: 'Ver meu protótipo' }).waitFor({ timeout: 60_000 })
  await shot(page, '04-verificacao')

  // 5. O relato do que aconteceu — a página inteira, e não só o que cabe na
  // dobra. `fullPage` porque o relato fica ABAIXO da verificação: uma captura
  // do viewport repetiria a imagem anterior byte a byte, que foi o que
  // aconteceu na primeira versão deste script.
  const report = page.getByRole('heading', { name: 'O que aconteceu na criação' })
  if (await report.count() > 0) {
    await report.scrollIntoViewIfNeeded()
    await page.screenshot({ path: resolve(outDirectory, '05-relato.png'), animations: 'disabled', fullPage: true })
    shots.push('05-relato')
  }

  // 6. A ajuda: as etapas, o glossário e o que o Studio nunca faz.
  await page.goto(`${origin}/studio/ajuda`)
  await page.waitForTimeout(300)
  await shot(page, '06-ajuda')

  // 7. O mesmo produto no escuro, porque o tema acompanha o sistema.
  const dark = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' })
  await dark.addCookies([{ name: 'dz23_studio_session', value: 'e2e', url: origin }])
  const darkPage = await dark.newPage()
  await darkPage.goto(`${origin}/studio/`)
  await darkPage.getByRole('textbox').first().fill('quero uma página para apresentar minha clínica e receber contatos')
  await darkPage.waitForTimeout(300)
  await shot(darkPage, '07-escuro')

  // 8. O celular: a mesma jornada num Pixel 5.
  const phone = await browser.newContext({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
  await phone.addCookies([{ name: 'dz23_studio_session', value: 'e2e', url: origin }])
  const phonePage = await phone.newPage()
  await phonePage.goto(`${origin}/studio/`)
  await phonePage.waitForTimeout(300)
  await shot(phonePage, '08-celular')

  await browser.close()
  process.stdout.write(`SCREENSHOTS=PASS destino=${outDirectory} imagens=${String(shots.length)}\n${shots.join('\n')}\n`)
} finally {
  stopServer()
}
