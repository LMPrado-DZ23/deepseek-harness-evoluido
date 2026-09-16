import { describe, expect, it } from 'vitest'
import { hostCanonico } from '@dz23-studio/policy'
import { egressCobre, isAllowedEndpoint, isLoopbackHostname } from '../src/manifest.js'

describe('o piso de política reconhece o loopback com mais folga que o destino permitido', () => {
  it('`*.localhost` conta como loopback aqui e é bloqueado como DESTINO', () => {
    // A diferença é de propósito: esta função decide o PISO, onde reconhecer de
    // menos aperta; `hostBloqueado` decide o destino, onde reconhecer de mais abre.
    expect(isLoopbackHostname('atacante.example.localhost')).toBe(true)
    expect(isAllowedEndpoint('http://atacante.example.localhost/')).toBe(false)
    expect(hostCanonico('atacante.example.localhost').forma).toBe('NOME')
  })

  it('o loopback de verdade é reconhecido em todas as escritas', () => {
    for (const host of ['127.0.0.1', '[::1]', '[::ffff:127.0.0.1]', 'localhost']) {
      expect(isLoopbackHostname(host), host).toBe(true)
    }
    expect(isLoopbackHostname('8.8.8.8')).toBe(false)
  })
})

describe('endereço permitido como destino', () => {
  it('as três escritas do mesmo endereço interno que passavam agora são recusadas', () => {
    expect(isAllowedEndpoint('http://[::ffff:169.254.169.254]/latest/meta-data/')).toBe(false)
    expect(isAllowedEndpoint('http://metadata.google.internal./computeMetadata/v1/')).toBe(false)
    expect(isAllowedEndpoint('http://100.100.100.200/latest/meta-data/')).toBe(false)
    expect(isAllowedEndpoint('http://[64:ff9b::a9fe:a9fe]/')).toBe(false)
    expect(isAllowedEndpoint('http://[fea0::1]/')).toBe(false)
    expect(isAllowedEndpoint('http://[::]/')).toBe(false)
  })

  it('o que já era recusado continua recusado', () => {
    for (const endereco of ['http://169.254.169.254/', 'http://2852039166/', 'http://10.0.0.1/', 'http://192.168.1.1/',
      'http://172.20.0.5/', 'http://db.internal/', 'http://x.localhost/', 'file:///etc/passwd', 'gopher://x/', 'http://x.local/']) {
      expect(isAllowedEndpoint(endereco), endereco).toBe(false)
    }
  })

  it('endereço público e loopback continuam servindo de destino', () => {
    for (const endereco of ['https://api.fornecedor.example/mcp', 'http://8.8.8.8/x', 'http://127.0.0.1:9000/mcp',
      'http://[::1]:9000/mcp', 'http://localhost:9000/mcp', 'http://[::ffff:127.0.0.1]/mcp', 'https://[2001:db8::1]/x']) {
      expect(isAllowedEndpoint(endereco), endereco).toBe(true)
    }
  })

  it('o que não é endereço nenhum é recusado, e não aceito por engano', () => {
    expect(isAllowedEndpoint('nao-e-um-endereco')).toBe(false)
    expect(isAllowedEndpoint('')).toBe(false)
  })
})

describe('lista de egress', () => {
  it('`*` casa UM rótulo e não atravessa ponto', () => {
    expect(egressCobre('api.fornecedor.example', '*.fornecedor.example')).toBe(true)
    expect(egressCobre('a.b.fornecedor.example', '*.fornecedor.example')).toBe(false)
    expect(egressCobre('fornecedor.example', '*.fornecedor.example')).toBe(false)
    expect(egressCobre('fornecedor.example', 'fornecedor.example')).toBe(true)
  })

  it('o ponto do padrão é ponto literal, e não "qualquer caractere"', () => {
    expect(egressCobre('apixfornecedor.example', 'api.fornecedor.example')).toBe(false)
  })
})
