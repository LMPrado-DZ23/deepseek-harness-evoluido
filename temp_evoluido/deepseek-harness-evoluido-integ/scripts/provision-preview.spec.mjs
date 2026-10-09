import { describe, expect, it } from 'vitest'
import { CONTEINER, argumentosDoSupervisor, etiquetaDaImagem, geradoPorEsteInstalador, sobreposicaoDaPrevia } from './provision-preview.mjs'

const A = `sha256:${'a'.repeat(64)}`
const B = `sha256:${'b'.repeat(64)}`
const base = { base: '/dados/p/.frigg', uid: 1000, gid: 1000, gidDoDocker: 1001, imagemDoSupervisor: A, imagemDoRuntime: B }

describe('o contêiner do supervisor', () => {
  const args = argumentosDoSupervisor(base)
  const par = (flag, valor) => args.some((item, i) => item === flag && args[i + 1] === valor)

  it('sem rede, só leitura, sem capacidades, sem novos privilégios', () => {
    expect(par('--network', 'none')).toBe(true)
    expect(args).toContain('--read-only')
    expect(par('--cap-drop', 'ALL')).toBe(true)
    expect(par('--security-opt', 'no-new-privileges:true')).toBe(true)
    expect(args.some(item => item.startsWith('-p') || item === '--publish' || item === '--privileged')).toBe(false)
  })

  it('o Docker e as execuções entram SÓ em leitura', () => {
    expect(par('-v', '/var/run/docker.sock:/var/run/docker.sock:ro')).toBe(true)
    expect(par('-v', '/dados/p/.frigg/generated-runs:/dados/p/.frigg/generated-runs:ro')).toBe(true)
  })

  it('roda como a pessoa, e o proxy também', () => {
    expect(par('--user', '1000:1000')).toBe(true)
    expect(par('-e', 'DZ23_PROXY_USER=1000:1000')).toBe(true)
  })

  it('as imagens entram pelo ID, e a do supervisor é também a do proxy', () => {
    expect(args.at(-1)).toBe(A)
    expect(par('-e', `DZ23_PROXY_IMAGE_DIGEST=${A}`)).toBe(true)
    expect(par('-e', `DZ23_RUNTIME_IMAGE_DIGEST=${B}`)).toBe(true)
    expect(par('--name', CONTEINER)).toBe(true)
    // Pasta, e não volume: o Docker não repovoa pasta com a dona da imagem.
    expect(par('-v', '/dados/p/.frigg/preview/proxies:/run/dz23-preview-proxies')).toBe(true)
    expect(par('-e', 'DZ23_PROXY_SOCKET_BIND=/dados/p/.frigg/preview/proxies')).toBe(true)
    expect(args.some(item => item.startsWith('DZ23_PROXY_SOCKET_VOLUME='))).toBe(false)
  })

  it('o token vai por arquivo montado, nunca por variável', () => {
    expect(par('-v', '/dados/p/.frigg/preview/segredos/supervisor-token:/run/secrets/dz23-preview-supervisor-token:ro')).toBe(true)
    expect(args.some(item => /TOKEN=(?!\/)/u.test(item))).toBe(false)
  })

  it.each([[0, 1000], [1000, 0]])('recusa root (%i:%i)', (uid, gid) => {
    expect(() => argumentosDoSupervisor({ ...base, uid, gid })).toThrow('root')
  })

  it('recusa imagem sem ID fixado', () => {
    expect(() => argumentosDoSupervisor({ ...base, imagemDoRuntime: 'node:22' })).toThrow('ID fixado')
    expect(() => argumentosDoSupervisor({ ...base, imagemDoSupervisor: 'frigg-preview-supervisor:local' })).toThrow('ID fixado')
  })
})

describe('a sobreposição da prévia', () => {
  const texto = sobreposicaoDaPrevia({ base: '/dados/p/.frigg', porta: 8088, portaDoHarness: 3080 })

  it('liga o supervisor com os caminhos desta máquina e o segredo por NOME', () => {
    expect(texto).toContain('enabled: true')
    expect(texto).toContain('socketPath: "/dados/p/.frigg/preview/run/supervisor.sock"')
    expect(texto).toContain('artifactRoot: "/dados/p/.frigg/generated-runs"')
    expect(texto).toContain('proxySocketRoot: "/dados/p/.frigg/preview/proxies"')
    expect(texto).toContain('edgeSecretRef: DZ23_EDGE_SECRET')
    expect(texto).toContain('capacityMode: single-process')
    expect(texto).toContain('publicPort: 8088')
  })

  it('acrescenta o host da borda SEM tirar os de sempre, e só na identidade', () => {
    // identidade; o host da borda também em `trustedHosts`.
    for (const host of ['"127.0.0.1:3080"', '"localhost:3080"']) expect(texto.split(host).length).toBe(2)
    expect(texto.split('"studio.dz23.localhost:8088"').length).toBe(3)
    for (const origem of ['"http://localhost:3080"', '"http://127.0.0.1:3080"']) expect(texto.split(origem).length).toBe(2)
    // identidade e a origem da prévia.
    expect(texto.split('"http://studio.dz23.localhost:8088"').length).toBe(3)
  })

  it('NÃO toca plugin cuja configuração ela apagaria (a entrada substitui a configuração inteira)', () => {
    expect(texto).not.toContain('id: dz23-studio-web')
    expect(texto).toContain('runtimeTimeoutMs: 30000')
    expect(texto).toContain('studioOrigin: "http://studio.dz23.localhost:8088"')
  })

  it('nenhuma expressão nem variável', () => {
    expect(texto).not.toContain('!!js')
    expect(texto).not.toContain('process.env')
  })
})

describe('a etiqueta da imagem vem do conteúdo', () => {
  it('é estável para o mesmo código e tem o formato certo', () => {
    const raiz = new URL('..', import.meta.url).pathname
    expect(etiquetaDaImagem(raiz)).toMatch(/^frigg-preview-supervisor:[a-f0-9]{12}$/u)
    expect(etiquetaDaImagem(raiz)).toBe(etiquetaDaImagem(raiz))
  })
})

describe('--atualizar só troca o que este instalador gerou', () => {
  it('reconhece os dois arquivos gerados e nada mais', () => {
    expect(geradoPorEsteInstalador(sobreposicaoDaPrevia({ base: '/dados/p/.frigg', porta: 8088, portaDoHarness: 3080 }))).toBe(true)
    expect(geradoPorEsteInstalador('{\n  "porta": 8088\n}\n')).toBe(true)
    expect(geradoPorEsteInstalador('- id: escrito-a-mao\n')).toBe(false)
  })
})
