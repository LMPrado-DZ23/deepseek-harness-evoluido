/**
 * T-17 — por onde a pesquisa SAI, e por que hoje ela não sai.
 *
 * A procedência (OS-63) já recusava uma nota cujo trecho literal não estivesse
 * na fonte. O que faltava era a BUSCA, e o que estava parado era a AUTORIZAÇÃO
 * — não o mecanismo. Estes testes exercitam o mecanismo no estado de hoje:
 * nenhuma saída autorizada.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_SALTOS,
  SEM_SAIDA_AUTORIZADA,
  dominioCobre,
  politicaDoAmbiente,
  saidaPermitida,
  saltoPermitido,
} from '../src/research-egress.js'

const AUTORIZADA = { dominios: ['fonte.example', 'gov.br'] }

describe('lista vazia RECUSA', () => {
  it('a política de hoje não deixa sair, e diz que ninguém autorizou', () => {
    // "Sem restrição" e "ninguém autorizou" são coisas opostas, e colapsá-las
    // transformaria um campo não preenchido em permissão de falar com a
    // internet inteira — a mesma escolha de `SEM_TABELA` no teto de dinheiro.
    expect(saidaPermitida('https://fonte.example/artigo', SEM_SAIDA_AUTORIZADA))
      .toEqual({ kind: 'RECUSADO', motivo: 'SEM_AUTORIZACAO', detalhe: 'https://fonte.example/artigo' })
  })

  it('o motivo é SEM_AUTORIZACAO e não FORA_DA_LISTA: não existe lista para acrescentar nada', () => {
    // Dizer "fora da lista" quando não há lista manda alguém acrescentar um
    // domínio a uma lista que ninguém ligou.
    const verdict = saidaPermitida('https://qualquer.example/', SEM_SAIDA_AUTORIZADA)
    expect(verdict).toMatchObject({ motivo: 'SEM_AUTORIZACAO' })
  })
})

describe('o que passa, e o que não passa', () => {
  it('um domínio autorizado e os subdomínios dele passam', () => {
    expect(saidaPermitida('https://fonte.example/artigo', AUTORIZADA)).toEqual({ kind: 'PERMITIDO', host: 'fonte.example' })
    expect(saidaPermitida('https://www.fonte.example/artigo', AUTORIZADA)).toEqual({ kind: 'PERMITIDO', host: 'www.fonte.example' })
  })

  it('a comparação é por RÓTULO: `notfonte.example` não é subdomínio de `fonte.example`', () => {
    // O erro clássico desta verificação é comparar sufixo de texto.
    expect(dominioCobre('notfonte.example', 'fonte.example')).toBe(false)
    expect(saidaPermitida('https://notfonte.example/', AUTORIZADA)).toMatchObject({ motivo: 'FORA_DA_LISTA' })
  })

  it('só `https:` — sem transporte autenticado a impressão não prova QUEM escreveu os bytes', () => {
    expect(saidaPermitida('http://fonte.example/', AUTORIZADA)).toMatchObject({ motivo: 'ESQUEMA_RECUSADO' })
    expect(saidaPermitida('file:///etc/passwd', AUTORIZADA)).toMatchObject({ motivo: 'ESQUEMA_RECUSADO' })
    expect(saidaPermitida('nao-e-endereco', AUTORIZADA)).toMatchObject({ motivo: 'ESQUEMA_RECUSADO' })
  })

  it('credencial dentro do endereço é recusada: ela vaza pelo registro de acesso e pelo salto seguinte', () => {
    expect(saidaPermitida('https://usuario:senha@fonte.example/', AUTORIZADA))
      .toMatchObject({ motivo: 'CREDENCIAL_NO_ENDERECO' })
    expect(saidaPermitida('https://usuario@fonte.example/', AUTORIZADA))
      .toMatchObject({ motivo: 'CREDENCIAL_NO_ENDERECO' })
  })

  it('host INTERNO é recusado pelo motivo certo, mesmo com a lista cheia', () => {
    // A mesma normalização do destino de integração: o IPv4 embutido em IPv6, o
    // ponto final do nome absoluto, e as faixas internas por NÚMERO.
    const politica = { dominios: ['fonte.example', 'internal'] }
    for (const endereco of ['https://169.254.169.254/', 'https://[::ffff:169.254.169.254]/',
      'https://metadata.google.internal./', 'https://10.0.0.1/', 'https://100.100.100.200/']) {
      expect(saidaPermitida(endereco, politica), endereco).toMatchObject({ motivo: 'HOST_INTERNO' })
    }
  })

  it('literal de endereço NUNCA casa com um domínio: autorizar um nome não autoriza o IP dele hoje', () => {
    expect(saidaPermitida('https://8.8.8.8/', { dominios: ['8.8.8.8'] })).toMatchObject({ motivo: 'FORA_DA_LISTA' })
  })
})

describe('cada redirecionamento passa pela MESMA porta', () => {
  it('um domínio autorizado que redireciona para dentro da rede é recusado no salto', () => {
    // Seguir o `Location` porque o endereço inicial era autorizado é conferir a
    // assinatura de um documento e depois ler outro.
    expect(saltoPermitido('https://169.254.169.254/', AUTORIZADA, 1)).toMatchObject({ motivo: 'HOST_INTERNO' })
    expect(saltoPermitido('https://outro.example/', AUTORIZADA, 1)).toMatchObject({ motivo: 'FORA_DA_LISTA' })
  })

  it('o salto autorizado passa, e o teto de saltos existe', () => {
    expect(saltoPermitido('https://fonte.example/b', AUTORIZADA, MAX_SALTOS - 1)).toMatchObject({ kind: 'PERMITIDO' })
    expect(saltoPermitido('https://fonte.example/b', AUTORIZADA, MAX_SALTOS)).toMatchObject({ motivo: 'SALTOS_DEMAIS' })
  })

  it('o teto de saltos é conferido ANTES do endereço: uma corrente infinita de endereços válidos ainda para', () => {
    expect(saltoPermitido('https://fonte.example/', AUTORIZADA, 99)).toMatchObject({ motivo: 'SALTOS_DEMAIS' })
  })
})

describe('a política vem do ambiente, e não de um padrão', () => {
  it('variável ausente ou vazia é lista vazia — e lista vazia recusa', () => {
    // Um padrão que autoriza é uma autorização que ninguém deu, e ela entraria
    // em toda instalação sem aparecer em decisão nenhuma.
    expect(politicaDoAmbiente({})).toEqual({ dominios: [] })
    expect(politicaDoAmbiente({ DZ23_RESEARCH_EGRESS: '  ' })).toEqual({ dominios: [] })
  })

  it('lê a lista, apara e normaliza', () => {
    expect(politicaDoAmbiente({ DZ23_RESEARCH_EGRESS: ' Fonte.Example , gov.br ' }))
      .toEqual({ dominios: ['fonte.example', 'gov.br'] })
  })

  it('entrada malformada numa lista de autorização é RECUSADA, e não interpretada', () => {
    // Interpretar `https://fonte.example/x` como o domínio `fonte.example` seria
    // adivinhar o que quem escreveu quis autorizar.
    expect(politicaDoAmbiente({ DZ23_RESEARCH_EGRESS: 'https://fonte.example/x,*.fonte.example,fonte,fonte.example' }))
      .toEqual({ dominios: ['fonte.example'] })
  })
})
