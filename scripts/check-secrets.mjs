#!/usr/bin/env node
/**
 * Portão de segredo comitado.
 *
 * A CI não tinha varredura nenhuma: um segredo colado por engano entrava e
 * seguia para o histórico sem um único sinal. Este portão lê os arquivos
 * RASTREADOS pelo git (o que sai do repositório é o que importa) e recusa a
 * forma de segredo, não o nome da variável: `DZ23_OMNIROUTE_KEY` é uma
 * referência legítima; `sk-` seguido de quarenta caracteres não é.
 *
 * Uso: node scripts/check-secrets.mjs [--self-test]
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Cada regra descreve UMA forma reconhecível de credencial.
 * `allowExample` marca as que aparecem legitimamente em documentação como
 * exemplo evidente (só quando o próprio texto se declara exemplo).
 */
export const SECRET_RULES = [
  { id: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/u },
  { id: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u },
  { id: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/u },
  { id: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/u },
  { id: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{32,}\b/u },
  { id: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/u },
  { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/u },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u },
  // As duas regras de URL capturam a SENHA para poder descartar marcador de
  // posição. O conjunto de caracteres é restrito de propósito: aspas, vírgula e
  // `$` não fazem parte de uma senha em URL, e aceitá-los fazia a regra
  // atravessar limite de string em linha minificada e casar coisa nenhuma.
  { id: 'postgres-dsn-with-password', pattern: /\bpostgres(?:ql)?:\/\/[A-Za-z0-9._~-]+:([A-Za-z0-9._~+-]{3,})@/u, secretGroup: 1 },
  { id: 'basic-auth-url', pattern: /\bhttps?:\/\/[A-Za-z0-9._~-]+:([A-Za-z0-9._~+-]{3,})@[A-Za-z0-9.-]/u, secretGroup: 1 },
]

/**
 * Valores que ANUNCIAM que não são a senha: interpolação, mascaramento e
 * marcador de posição. Documentação e prova precisam mostrar a FORMA da URL sem
 * carregar credencial, e recusar isso ensinaria a contornar o portão.
 */
const PLACEHOLDER = /^(?:\*+|x+|senha|password|passwd|pass|secret|changeme|token|examplo|exemplo|example|placeholder|redacted|dummy|fake|test|teste|[A-Z][A-Z0-9_]{2,})$/u

/**
 * Marcas que declaram, no próprio arquivo, que aquilo é fixture ou exemplo.
 * Um teste PRECISA conter a forma proibida para provar que o portão a pega; o
 * que não pode é um segredo de verdade se esconder atrás dessa marca, então ela
 * só vale em arquivo de teste ou de portão.
 */
const FIXTURE_PATH = /(?:(?:^|\/)(?:tests?|__tests__|fixtures?)\/)|(?:\.(?:spec|test)\.[cm]?[jt]sx?$)/u
const GATE_PATH = /^scripts\/check-secrets\.(?:mjs|spec\.mjs)$/u

/**
 * As ÚNICAS isenções, uma a uma, com motivo.
 *
 * Um portão sem isenção nenhuma é contornado no primeiro falso positivo, e uma
 * isenção aberta deixa de ser portão. Então cada entrada nomeia arquivo E
 * regra, e o portão REPROVA quando uma isenção não casa mais com nada: uma
 * dispensa esquecida é como a varredura apodrece sem ninguém notar.
 */
export const SECRET_ALLOWLIST = [
  {
    path: '.github/workflows/verify.yml',
    rule: 'postgres-dsn-with-password',
    reason: 'senha do banco efêmero do runner, criado e destruído no job, sem porta fora da máquina',
  },
]

/** Arquivos binários ou gerados que não têm segredo em texto para procurar. */
const SKIPPED = /\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|gz|tar|bundle|wasm|mp4|svg)$/u

/**
 * Uma linha suspeita, com o mínimo necessário para achar sem vazar o valor.
 * @param path - caminho do arquivo.
 * @param source - conteúdo do arquivo.
 * @returns achados: arquivo, linha e qual regra bateu. NUNCA o trecho casado.
 */
export function secretFindings(path, source) {
  if (FIXTURE_PATH.test(path) || GATE_PATH.test(path)) return []
  const findings = []
  const lines = source.split('\n')
  for (const [index, line] of lines.entries()) {
    // Uma linha que diz explicitamente que é um exemplo desativado continua
    // sendo lida: só a marca do arquivo isenta, nunca a marca da linha - senão
    // bastaria escrever "exemplo" ao lado do segredo.
    for (const rule of SECRET_RULES) {
      const match = rule.pattern.exec(line)
      if (match === null) continue
      const captured = rule.secretGroup === undefined ? undefined : match[rule.secretGroup]
      if (captured !== undefined && PLACEHOLDER.test(captured)) continue
      if (SECRET_ALLOWLIST.some(entry => entry.path === path && entry.rule === rule.id)) {
        findings.push({ path, line: index + 1, rule: rule.id, allowed: true })
        continue
      }
      findings.push({ path, line: index + 1, rule: rule.id })
    }
  }
  return findings
}

/** Os arquivos que o git realmente carrega. */
async function trackedFiles() {
  const { stdout } = await run('git', ['ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024 })
  return stdout.split('\0').filter(path => path !== '' && !SKIPPED.test(path))
}

function selfTest() {
  const cases = [
    ['chave privada reprova', secretFindings('a.ts', '-----BEGIN PRIVATE KEY-----').length === 1],
    ['chave AWS reprova', secretFindings('a.ts', 'const k = "AKIA' + 'ABCDEFGHIJKLMNOP"').length === 1],
    ['token do GitHub reprova', secretFindings('a.ts', 'ghp_' + 'a'.repeat(36)).length === 1],
    ['chave sk- reprova', secretFindings('a.ts', 'sk-' + 'a'.repeat(40)).length === 1],
    ['JWT reprova', secretFindings('a.ts', `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.${'c'.repeat(20)}`).length === 1],
    ['DSN com senha reprova', secretFindings('a.ts', 'postgres://user:hunter2gato@host/db').length >= 1],
    ['URL com usuário e senha reprova', secretFindings('a.ts', 'https://user:hunter2gato@example.com/x').length >= 1],
    // O que NÃO pode reprovar: o produto inteiro resolve segredo por referência.
    ['nome de variável de ambiente passa', secretFindings('a.ts', "apiKeyEnv: 'DZ23_OMNIROUTE_KEY'").length === 0],
    ['DSN sem senha passa', secretFindings('a.ts', 'postgres://host:5432/db').length === 0],
    ['URL comum passa', secretFindings('a.ts', 'https://example.com/v1/logs').length === 0],
    ['fixture de teste é isenta', secretFindings('plugins/x/tests/a.spec.ts', 'ghp_' + 'a'.repeat(36)).length === 0],
    ['"exemplo" na linha NÃO isenta', secretFindings('a.ts', '// exemplo: ghp_' + 'a'.repeat(36)).length === 1],
    // Documentação e prova mostram a FORMA da URL sem carregar credencial.
    ['senha interpolada passa', secretFindings('a.ts', 'postgres://u:${senha}@host/db').length === 0],
    ['senha mascarada passa', secretFindings('a.md', 'postgresql://dz23_test:***@127.0.0.1:5432/dz23_test').length === 0],
    ['marcador de posição em maiúsculas passa', secretFindings('a.md', 'postgresql://USUARIO:SENHA@127.0.0.1:5432/BASE').length === 0],
    ['linha minificada com duas strings não vira achado', secretFindings('a.ts', "createEmailSender({APP_SMTP_URL:'http://example.test',APP_EMAIL_FROM:'owner@example.test'})").length === 0],
    ['arquivo .spec.mjs fora de tests/ é isento', secretFindings('apps/x/operator.spec.mjs', 'postgres://user:hunter2gato@host/db').length === 0],
    // A isenção marca, não apaga: o achado continua existindo, com `allowed`.
    ['isenção marca em vez de sumir', secretFindings('.github/workflows/verify.yml', 'postgresql://u:hunter2gato@h/d')[0]?.allowed === true],
    ['isenção vale só para a regra nomeada', secretFindings('.github/workflows/verify.yml', 'ghp_' + 'a'.repeat(36))[0]?.allowed !== true],
  ]
  const failed = cases.filter(([, ok]) => !ok).map(([name]) => name)
  console.log(`SECRET_SCAN_SELF_TEST=${failed.length === 0 ? 'PASS' : 'FAIL'} checks=${String(cases.length)}${failed.length === 0 ? '' : ` falhou=${failed.join(', ')}`}`)
  return failed.length === 0
}

if (process.argv.includes('--self-test')) {
  process.exitCode = selfTest() ? 0 : 1
} else {
  const files = await trackedFiles()
  if (files.length === 0) {
    console.error('SECRET_SCAN=FAIL motivo=nenhum arquivo rastreado foi lido')
    process.exitCode = 1
  } else {
    const all = []
    for (const path of files) {
      const source = await readFile(path, 'utf8').catch(() => '')
      all.push(...secretFindings(path, source))
    }
    const findings = all.filter(finding => finding.allowed !== true)
    const used = all.filter(finding => finding.allowed === true)
    const stale = SECRET_ALLOWLIST.filter(entry => !used.some(finding => finding.path === entry.path && finding.rule === entry.rule))
    for (const finding of findings) console.error(`${finding.path}:${String(finding.line)} possível ${finding.rule}`)
    for (const entry of stale) console.error(`isenção obsoleta: ${entry.path} / ${entry.rule} não casa mais com nada - remova-a`)
    const failed = findings.length + stale.length
    console.log(`SECRET_SCAN=${failed === 0 ? 'PASS' : 'FAIL'} arquivos=${String(files.length)} achados=${String(findings.length)} isencoes=${String(SECRET_ALLOWLIST.length)} obsoletas=${String(stale.length)}`)
    process.exitCode = failed === 0 ? 0 : 1
  }
}
