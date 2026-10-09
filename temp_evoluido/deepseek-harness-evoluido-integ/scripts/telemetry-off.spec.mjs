import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)
const read = path => readFile(fileURLToPath(new URL(path, root)), 'utf8')

/** O bloco `config` da linha pedida, dentro de um patch de perfil. */
function rowConfig(source, id) {
  const row = new RegExp(`^- id: ${id}\\n(?<body>(?:[ \\t].*\\n|\\n)*)`, 'mu').exec(source)
  return row?.groups?.body ?? null
}

describe('telemetria comercial', () => {
  it('está desligada no perfil do Studio, não só na imagem', async () => {
    // O bundle upstream sobe `session-telemetry-otel` em FEEDBACK_ONLY para
    // harness-telemetry.deepseeksvc.com, com o export sendo a cópia crua da
    // sessão. Quem rodasse o perfil fora do contêiner mandava conversa de
    // cliente para um terceiro. Config não desliga a LINHA, mas desliga o
    // MODO: em DISABLED o plugin não constrói pipeline nem lê o endpoint.
    const profile = await read('dsh-home/profiles/studio/cordis.patch.yml')
    const config = rowConfig(profile, 'session-telemetry-otel')
    expect(config, 'o perfil do Studio não declara mais a linha de telemetria').not.toBe(null)
    expect(config).toMatch(/^\s+mode:\s*DISABLED\s*$/mu)
  })

  it('o perfil não carrega nenhum endereço de coleta de terceiro', async () => {
    // Só o que o carregador lê: um comentário PODE citar o endereço para
    // explicar de onde ele vinha, e citar não é configurar.
    const profile = await read('dsh-home/profiles/studio/cordis.patch.yml')
    const effective = profile.split('\n').filter(line => !/^\s*#/u.test(line)).join('\n')
    expect(effective).not.toMatch(/deepseeksvc\.com/u)
    expect(effective).not.toMatch(/DSH_TELEMETRY_OTLP_URL/u)
  })

  it('a imagem continua com a segunda tranca', async () => {
    // Uma tranca não substitui a outra: quem constrói a imagem pode trocar o
    // perfil, e quem troca o perfil pode não usar a imagem.
    expect(await read('deploy/studio/Dockerfile')).toMatch(/DSH_TELEMETRY_DISABLED=1/u)
  })

  it('o upstream continua intocado', async () => {
    // A correção é por composição. Se algum dia ela virar edição do upstream,
    // este teste avisa antes do portão de pin.
    const upstream = await read('third_party/deepseek-harness/packages/bundle/base/cordis.patch.yml')
    expect(upstream).toMatch(/harness-telemetry\.deepseeksvc\.com/u)
  })
})
