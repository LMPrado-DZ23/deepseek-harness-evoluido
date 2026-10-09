#!/usr/bin/env node
import assert from 'node:assert/strict'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'

const controlDirectory = resolve(process.argv[2] ?? '')
const edgePath = process.env.DZ23_EDGE_PATH?.trim()
const playwrightModule = process.env.DZ23_PLAYWRIGHT_CORE_MODULE?.trim()
assert.ok(process.platform === 'win32', 'A prova cliente deve rodar no Windows.')
assert.ok(process.argv[2] && isAbsolute(process.argv[2]), 'Informe um diretório de controle absoluto e temporário.')
assert.match(basename(controlDirectory), /^dz23-assistant-browser-proof-[a-z0-9-]+$/u)
assert.ok(edgePath && isAbsolute(edgePath), 'DZ23_EDGE_PATH deve apontar para o Microsoft Edge.')
assert.ok(playwrightModule, 'DZ23_PLAYWRIGHT_CORE_MODULE deve apontar para o Playwright isolado e fixado.')

const controlPath = join(controlDirectory, 'ready.json')
const resultPath = join(controlDirectory, 'result.json')
let browser
let sessionId = ''
try {
  const info = await lstat(controlPath)
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'O controle do runtime deve ser um arquivo regular.')
  const control = JSON.parse(await readFile(controlPath, 'utf8'))
  assert.match(control.origin, /^http:\/\/127\.0\.0\.1:\d+$/u)
  assert.equal(typeof control.sessionToken, 'string')
  assert.ok(control.sessionToken.length >= 32)
  assert.equal(typeof control.expectedSessionId, 'string')
  sessionId = control.expectedSessionId

  const { chromium } = await import(playwrightModule)
  browser = await chromium.launch({ executablePath: edgePath, headless: true })
  const context = await browser.newContext()
  await context.addCookies([{
    name: 'dz23_studio_session', value: control.sessionToken, url: control.origin,
    httpOnly: true, sameSite: 'Lax', secure: false,
  }])
  const page = await context.newPage()
  await page.goto(`${control.origin}/studio/assistente`)
  assert.equal(await page.locator('h1').textContent(), 'Converse com o DZ23')
  await page.getByRole('button', { name: 'Abrir conversa segura' }).click()
  await page.waitForURL(url => url.origin === control.origin && url.pathname === '/', { timeout: 30_000 })
  const selection = await page.evaluate(() => window.localStorage.getItem('dsh.sessions.current'))
  assert.deepEqual(JSON.parse(selection ?? 'null'), { sessionId })
  await writeFile(resultPath, JSON.stringify({ status: 'PASS', sessionId }), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  process.stdout.write(`${JSON.stringify({ proof: 'DZ23_STUDIO_M71_BROWSER_HANDOFF', status: 'PASS', browser: 'Microsoft Edge', sessionSelected: true, harnessOpened: true })}\n`)
} catch (error) {
  await writeFile(resultPath, JSON.stringify({ status: 'FAIL', sessionId, error: String(error) }), { encoding: 'utf8', mode: 0o600, flag: 'wx' }).catch(() => undefined)
  throw error
} finally {
  await browser?.close()
}
