import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { conferirBytes, digestDe, gravarBlobConferido, gravarConferido, hexDoDigest, manifestoDaPlataforma, urlDoToken } from './puxar-imagem.mjs'

describe('puxar-imagem', () => {
  it('o token anônimo sai do desafio Bearer, e só de um realm https', () => {
    expect(urlDoToken('Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/node:pull"'))
      .toBe('https://auth.docker.io/token?service=registry.docker.io&scope=repository%3Alibrary%2Fnode%3Apull')
    expect(urlDoToken('Bearer realm="http://inseguro/token"')).toBeUndefined()
    expect(urlDoToken('Basic realm="x"')).toBeUndefined()
    expect(urlDoToken(null)).toBeUndefined()
  })
  it('escolhe a plataforma pedida no índice', () => {
    const indice = { manifests: [
      { digest: 'sha256:a', platform: { os: 'linux', architecture: 'arm64' } },
      { digest: 'sha256:b', platform: { os: 'linux', architecture: 'amd64' } },
    ] }
    expect(manifestoDaPlataforma(indice, 'linux/amd64')?.digest).toBe('sha256:b')
    expect(manifestoDaPlataforma(indice, 'windows/amd64')).toBeUndefined()
  })
  it('um digest forjado não vira caminho', () => {
    expect(hexDoDigest(`sha256:${'a'.repeat(64)}`)).toBe('a'.repeat(64))
    expect(() => hexDoDigest('sha256:../../etc/passwd')).toThrow()
    expect(() => hexDoDigest(`sha512:${'a'.repeat(64)}`)).toThrow()
  })
  it('o digest é o sha256 do conteúdo', () => {
    expect(digestDe(Buffer.from(''))).toBe('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('bytes que não batem com o digest são recusados', () => {
    expect(() => conferirBytes(digestDe(Buffer.from('a')), Buffer.from('a'))).not.toThrow()
    expect(() => conferirBytes(digestDe(Buffer.from('a')), Buffer.from('b'))).toThrow(/não bate/u)
  })
  it('uma camada adulterada não fica no disco, nem pela metade', async () => {
    const pasta = mkdtempSync(join(tmpdir(), 'puxar-'))
    const certo = Buffer.from('camada verdadeira')
    const destino = join(pasta, 'x')
    await expect(gravarConferido([Buffer.from('camada adulterada')], destino, digestDe(certo))).rejects.toThrow(/veio como/u)
    expect(existsSync(destino)).toBe(false)
    expect(existsSync(`${destino}.parcial`)).toBe(false)
    await gravarConferido([certo], destino, digestDe(certo))
    expect(readFileSync(destino, 'utf8')).toBe('camada verdadeira')
  })

  it('um manifesto adulterado não é gravado', async () => {
    const pasta = mkdtempSync(join(tmpdir(), 'puxar-m-'))
    const certo = Buffer.from('{"schemaVersion":2}')
    await expect(gravarBlobConferido(pasta, digestDe(certo), Buffer.from('{"schemaVersion":3}'))).rejects.toThrow(/não bate/u)
    expect(existsSync(join(pasta, hexDoDigest(digestDe(certo))))).toBe(false)
    await gravarBlobConferido(pasta, digestDe(certo), certo)
    expect(existsSync(join(pasta, hexDoDigest(digestDe(certo))))).toBe(true)
  })
})
