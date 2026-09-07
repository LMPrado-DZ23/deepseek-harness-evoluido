import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const summaryFields = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']

export function assertRegularFileWithinRoot(root, candidate) {
  const rootReal = realpathSync(root)
  const absolute = resolve(rootReal, candidate)
  const lexicalRelative = relative(rootReal, absolute)
  if (lexicalRelative === '' || lexicalRelative === '..' || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) {
    throw new Error(`teste fora do repositório: ${candidate}`)
  }
  const entry = lstatSync(absolute)
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`teste não é arquivo regular: ${candidate}`)
  }
  const real = realpathSync(absolute)
  const realRelative = relative(rootReal, real)
  if (realRelative === '' || realRelative === '..' || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
    throw new Error(`teste resolve fora do repositório: ${candidate}`)
  }
  return absolute
}

export function assertTapSuccess(output, label) {
  const occurrences = new Map(summaryFields.map((field) => [field, []]))
  for (const match of output.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gmu)) {
    occurrences.get(match[1]).push(Number.parseInt(match[2], 10))
  }
  for (const field of summaryFields) {
    if (occurrences.get(field).length !== 1) {
      throw new Error(`${label} deve produzir exatamente um resumo TAP raiz: ${field}`)
    }
  }
  const plans = [...output.matchAll(/^1\.\.(\d+)\s*$/gmu)].map((match) => Number.parseInt(match[1], 10))
  if (plans.length !== 1) throw new Error(`${label} deve produzir exatamente um plano TAP raiz`)
  const values = new Map(summaryFields.map((field) => [field, occurrences.get(field)[0]]))
  const tests = values.get('tests')
  const pass = values.get('pass')
  if (plans[0] !== tests) throw new Error(`${label} tem plano TAP divergente: plan=${plans[0]} tests=${tests}`)
  if (tests === 0) throw new Error(`${label} não executou teste algum`)
  if (values.get('fail') !== 0 || values.get('cancelled') !== 0 || values.get('skipped') !== 0 || values.get('todo') !== 0) {
    throw new Error(`${label} não executou integralmente: fail=${values.get('fail')} cancelled=${values.get('cancelled')} skipped=${values.get('skipped')} todo=${values.get('todo')}`)
  }
  if (pass !== tests) throw new Error(`${label} tem contagem inconsistente: tests=${tests} pass=${pass}`)
  return { tests, pass }
}
