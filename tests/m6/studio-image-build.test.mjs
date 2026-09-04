import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPlan, validateBuildState } from '../../scripts/build-studio-image.mjs'

const head = 'a'.repeat(40)

test('plano vincula build, label e tag ao HEAD validado', () => {
  assert.deepEqual(validateBuildState({ head, status: '', tag: 'dz23-studio:m61' }), { head, tag: 'dz23-studio:m61' })
  const plan = buildPlan({ head, tag: 'dz23-studio:m61' })
  assert.ok(plan.includes(`STUDIO_COMMIT=${head}`))
  assert.ok(plan.includes(`org.opencontainers.image.revision=${head}`))
  assert.equal(plan.at(-1), '.')
})

test('build recusa revisão, tag ou árvore não reproduzível', () => {
  assert.throws(() => validateBuildState({ head: 'a'.repeat(39), status: '', tag: 'dz23-studio:m61' }), /HEAD Git inválido/u)
  assert.throws(() => validateBuildState({ head, status: ' M package.json', tag: 'dz23-studio:m61' }), /totalmente limpa/u)
  assert.throws(() => validateBuildState({ head, status: '?? surprise.txt', tag: 'dz23-studio:m61' }), /totalmente limpa/u)
  assert.throws(() => validateBuildState({ head, status: '', tag: '--privileged' }), /tag de imagem inválida/u)
})
