import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const studioRoot = resolve(process.cwd())
const proof = `# M5 — Prova de exportação do Integration Hub

- Resultado: **BLOCKED_EXTERNAL**
- Motivo: \`AUTHENTICATED_BUILDER_INGRESS_NOT_PRESENT\`.
- Ingresso autenticado do builder: \`NOT_PRESENT\`.
- Build, attestação de aceite e standalone: \`NOT_EXECUTED\`.
- Exportação: \`NOT_EXECUTED\`.
- Aplicação pronta: **não afirmada**.
- A prova não fabrica \`server.js\`, não promove o projeto por \`transition()\` e não grava uma run \`PASSED\` manualmente.
- O teste de integração \`pipeline-export.integration.spec.ts\` prova que uma execução \`BLOCKED_EXTERNAL\` criada pelo pipeline real continua não exportável, inclusive sob tentativa de outro tenant. Esse teste é somente o contrato entre os módulos; não substitui ingresso autenticado, build, Playwright ou exportação física.

Para obter \`GO\`, uma fatia futura deve fornecer ingresso de artefato autenticado no supervisor e attestação/exportação verificadas. Configurar imagem, diretório local ou socket não contorna esse requisito.
`

writeFileSync(resolve(studioRoot, 'docs/proofs/M5-integration-hub-proof.md'), proof)
process.stderr.write(`${JSON.stringify({
  decision: 'BLOCKED_EXTERNAL',
  reason: 'AUTHENTICATED_BUILDER_INGRESS_NOT_PRESENT',
  builderIngress: 'NOT_PRESENT',
  build: 'NOT_EXECUTED',
  acceptanceAttestation: 'NOT_PRESENT',
  export: 'NOT_EXECUTED',
  applicationReady: false,
}, null, 2)}\nINTEGRATION_HUB=BLOCKED_EXTERNAL\n`)
process.exitCode = 2
