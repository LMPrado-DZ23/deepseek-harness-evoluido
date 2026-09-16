import { describe, expect, it } from 'vitest'
import { hostBloqueado, hostCanonico, hostLoopback, ipv4Bloqueado, ipv6Bloqueado } from '../src/host.js'
import { egressCobre, isAllowedEndpoint, isLoopbackHostname } from '../src/manifest.js'

/** O host como o `URL` do Node o entrega, que é o que a produção vê. */
function doEndereco(endereco: string): string {
  return new URL(endereco).hostname
}

describe('forma canônica do host', () => {
  it('reconhece o IPv4 EMBUTIDO num literal IPv6, em todas as formas que o Node produz', () => {
    expect(hostCanonico('[::ffff:169.254.169.254]').octetos).toEqual([169, 254, 169, 254])
    expect(hostCanonico(doEndereco('http://[::ffff:169.254.169.254]/')).octetos).toEqual([169, 254, 169, 254])
    expect(hostCanonico(doEndereco('http://[0:0:0:0:0:ffff:10.0.0.1]/')).octetos).toEqual([10, 0, 0, 1])
    expect(hostCanonico('[64:ff9b::a9fe:a9fe]').octetos).toEqual([169, 254, 169, 254])
  })

  it('o ponto final do nome absoluto cai: `x.internal.` e `x.internal` são o mesmo nome', () => {
    expect(hostCanonico('metadata.google.internal.').texto).toBe('metadata.google.internal')
    expect(hostCanonico('METADATA.GOOGLE.INTERNAL.').forma).toBe('NOME')
  })

  it('`::` e `::1` NÃO viram o IPv4 0.0.0.1: um é o não especificado, o outro é o loopback', () => {
    expect(hostCanonico('[::1]').octetos).toBeUndefined()
    expect(hostCanonico('[::]').octetos).toBeUndefined()
    expect(hostLoopback(hostCanonico('[::1]'))).toBe(true)
  })

  it('recusa um IPv6 mal formado em vez de inventar grupos', () => {
    expect(hostCanonico('1:2:3:4:5:6:7::8').forma).toBe('NOME')
    expect(hostCanonico('[gggg::1]').forma).toBe('NOME')
    expect(hostCanonico('[1::2::3]').forma).toBe('NOME')
    expect(hostCanonico('[1.2.3.4::1]').forma).toBe('NOME')
  })

  it('o IPv4 só é IPv4 com quatro octetos decimais dentro da faixa', () => {
    expect(hostCanonico('10.0.0.1').octetos).toEqual([10, 0, 0, 1])
    expect(hostCanonico('10.0.0.256').forma).toBe('NOME')
    expect(hostCanonico('10.0.0.01').forma).toBe('NOME')
    expect(hostCanonico('10.0.1').forma).toBe('NOME')
  })
})

describe('faixas', () => {
  it('as faixas internas por NÚMERO, inclusive as que a lista de texto não tinha', () => {
    for (const octetos of [[0, 1, 1, 1], [10, 0, 0, 1], [100, 100, 100, 200], [100, 64, 0, 1], [169, 254, 169, 254],
      [172, 16, 0, 1], [172, 31, 255, 255], [192, 0, 0, 1], [192, 168, 1, 1], [198, 18, 0, 1], [224, 0, 0, 1], [255, 255, 255, 255]]) {
      expect(ipv4Bloqueado(octetos), octetos.join('.')).toBe(true)
    }
    for (const octetos of [[8, 8, 8, 8], [172, 15, 0, 1], [172, 32, 0, 1], [100, 63, 0, 1], [100, 128, 0, 1], [192, 0, 1, 1], [198, 20, 0, 1], [127, 0, 0, 1]]) {
      expect(ipv4Bloqueado(octetos), octetos.join('.')).toBe(false)
    }
  })

  it('`fe80::/10` inteiro, e não só o prefixo textual `fe80:`', () => {
    expect(ipv6Bloqueado(hostCanonico('[fe80::1]').grupos!)).toBe(true)
    expect(ipv6Bloqueado(hostCanonico('[fea0::1]').grupos!)).toBe(true)
    expect(ipv6Bloqueado(hostCanonico('[febf::1]').grupos!)).toBe(true)
    expect(ipv6Bloqueado(hostCanonico('[fec0::1]').grupos!)).toBe(false)
  })

  it('`fc00::/7` cobre `fd`, e o multicast entra', () => {
    expect(ipv6Bloqueado(hostCanonico('[fc00::1]').grupos!)).toBe(true)
    expect(ipv6Bloqueado(hostCanonico('[fd12::1]').grupos!)).toBe(true)
    expect(ipv6Bloqueado(hostCanonico('[ff02::1]').grupos!)).toBe(true)
    expect(ipv6Bloqueado(hostCanonico('[2001:db8::1]').grupos!)).toBe(false)
  })

  it('loopback NÃO é bloqueado — é caso suportado, e tem nível próprio', () => {
    for (const host of ['127.0.0.1', '127.9.9.9', '[::1]', 'localhost', '[::ffff:127.0.0.1]']) {
      expect(hostBloqueado(hostCanonico(host)), host).toBe(false)
      expect(hostLoopback(hostCanonico(host)), host).toBe(true)
    }
  })

  it('`*.localhost` é NOME e não é a própria máquina: bloqueado como destino', () => {
    expect(hostBloqueado(hostCanonico('atacante.example.localhost'))).toBe(true)
    // …e continua contando como loopback para o PISO de política, onde
    // reconhecer de menos aperta em vez de abrir.
    expect(isLoopbackHostname('atacante.example.localhost')).toBe(true)
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
