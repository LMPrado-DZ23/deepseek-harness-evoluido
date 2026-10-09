import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  BLOQUEIOS, CAMPOS_DE_PROMOCAO, DECISOES, DESCONHECIDO,
  capacidadePreservada, desconhecidos, problemasDoRegistro, promocao,
} from './candidate-registry.mjs'

/**
 * EVO-01 / AT-113 / AT-114 — decidir antes de instalar.
 *
 * O MASTER V6 §46 manda registrar a decisão no mecanismo existente, e proíbe
 * inventar pin, licença ou veredito. A parte que precisa ser CÓDIGO é uma só: a
 * recusa de promoção. Um documento dizendo "candidato incompatível não é
 * promovido" não impede ninguém de promover.
 */

/** Um candidato com TUDO resolvido — o único estado que sustenta promoção. */
function completo(overrides = {}) {
  return {
    id: 'X', capacidade: 'gerar componente para dois alvos', autoridade_atual: 'geradores do prompt-to-app',
    decisao: 'INTEGRAR_COMPONENTE', identidade_resolvida: true, estado: 'NAO_ADOTADO',
    proprietario_repositorio: 'dono/repo', versao_avaliada: 'v1.2.3', licenca: 'MIT', licenca_aprovada: true,
    telemetria: 'nenhuma', telemetria_sai_da_maquina: false, dados_enviados: 'nenhum',
    custo: 'zero', custo_aprovado: true, testes: 'EXECUTADOS',
    plano_saida: 'remover a dependência e voltar ao gerador atual', instalacao_autorizada: true,
    ...overrides,
  }
}

describe('AT-113 — admissão pela LACUNA, e não pelo nome', () => {
  it('só um registro com tudo resolvido sustenta promoção', () => {
    expect(promocao(completo())).toEqual({ promovivel: true, bloqueios: [], capacidade_preservada: true })
  })

  it('cada campo exigido, sozinho, impede a promoção', () => {
    // Um por um: um teste que quebra tudo de uma vez passaria com um único
    // campo sendo conferido.
    for (const campo of CAMPOS_DE_PROMOCAO) {
      const verdict = promocao(completo({ [campo]: DESCONHECIDO }))
      expect(verdict.promovivel, campo).toBe(false)
      expect(verdict.bloqueios, campo).toContain('CAMPO_DESCONHECIDO')
    }
  })

  it('AUSENTE e DESCONHECIDO contam igual: os dois são ignorância', () => {
    // Tratar a ausência como "não se aplica" é o branco que o portão do P37 já
    // recusa desde que existe.
    expect(desconhecidos(completo({ licenca: undefined }))).toContain('licenca')
    expect(desconhecidos(completo({ licenca: DESCONHECIDO }))).toContain('licenca')
    expect(desconhecidos(completo({ licenca: '' }))).toContain('licenca')
    expect(desconhecidos(completo())).toEqual([])
  })

  it('a decisão é uma das QUATRO, e "em estudo" não é adoção', () => {
    // Sim/não esconderia as duas saídas que mais valem: aproveitar a ideia sem
    // o código, e reimplementar um contrato pequeno.
    expect(DECISOES).toContain('APROVEITAR_CONCEITO')
    expect(DECISOES).toContain('REIMPLEMENTAR_CONTRATO')
    for (const decisao of ['APROVEITAR_CONCEITO', 'REIMPLEMENTAR_CONTRATO', 'NAO_ADOTAR', 'EM_ESTUDO']) {
      expect(promocao(completo({ decisao })).bloqueios, decisao).toContain('DECISAO_NAO_E_DE_ADOCAO')
    }
  })

  it('devolve TODOS os bloqueios, e não o primeiro', () => {
    // Uma recusa por vez faria alguém resolver a licença para descobrir que
    // faltava o plano de saída.
    const verdict = promocao(completo({ licenca_aprovada: false, custo_aprovado: false, testes: 'NAO_EXECUTADOS' }))
    expect(verdict.bloqueios).toEqual(expect.arrayContaining(['LICENCA_NAO_RESOLVIDA', 'CUSTO_NAO_APROVADO', 'SEM_TESTES']))
  })

  it('a ordem dos bloqueios é estável: duas leituras iguais comparam', () => {
    const quebrado = completo({ licenca_aprovada: false, custo_aprovado: false })
    expect(promocao(quebrado).bloqueios).toEqual(promocao(quebrado).bloqueios)
    for (const motivo of promocao(quebrado).bloqueios) expect(BLOQUEIOS).toContain(motivo)
  })

  it('estar no registro NÃO instala nada: `instalacao_autorizada` é campo, e falso bloqueia', () => {
    // §02: este pacote não autoriza instalação.
    expect(promocao(completo({ instalacao_autorizada: false })).bloqueios).toContain('INSTALACAO_NAO_AUTORIZADA')
  })
})

describe('AT-114 — candidato incompatível é recusado SEM perder a capacidade', () => {
  it('identidade não resolvida impede a promoção', () => {
    // §46: "nomes sem proprietário/repositório identificado não podem ser
    // instalados por adivinhação".
    const verdict = promocao(completo({ identidade_resolvida: false }))
    expect(verdict.promovivel).toBe(false)
    expect(verdict.bloqueios).toContain('IDENTIDADE_NAO_RESOLVIDA')
  })

  it('telemetria que sai da máquina impede a promoção no perfil privado-local', () => {
    const verdict = promocao(completo({ telemetria_sai_da_maquina: true }))
    expect(verdict.promovivel).toBe(false)
    expect(verdict.bloqueios).toContain('TELEMETRIA_INCOMPATIVEL')
  })

  it('e a MESMA telemetria NÃO impede num perfil que permite saída', () => {
    // Incompatível com o perfil, e não "ruim". Bloquear nos dois perfis seria
    // transformar uma regra de privacidade numa opinião sobre o candidato.
    const verdict = promocao(completo({ telemetria_sai_da_maquina: true }), { perfil: 'melhor-qualidade' })
    expect(verdict.bloqueios).not.toContain('TELEMETRIA_INCOMPATIVEL')
    expect(verdict.promovivel).toBe(true)
  })

  it('licença não resolvida impede a promoção', () => {
    expect(promocao(completo({ licenca_aprovada: false })).bloqueios).toContain('LICENCA_NAO_RESOLVIDA')
  })

  it('NENHUMA recusa remove a capacidade — é o ponto inteiro deste cenário', () => {
    // O risco de um registro de candidatos não é adotar demais: é a capacidade
    // sumir junto com o candidato recusado. "Não adotamos o Mitosis" vira, três
    // meses depois, "não fazemos componentes multi-formato".
    for (const quebra of [
      { identidade_resolvida: false }, { telemetria_sai_da_maquina: true },
      { licenca_aprovada: false }, { custo_aprovado: false }, { decisao: 'NAO_ADOTAR' },
    ]) {
      const verdict = promocao(completo(quebra))
      expect(verdict.promovivel, JSON.stringify(quebra)).toBe(false)
      expect(verdict.capacidade_preservada, JSON.stringify(quebra)).toBe(true)
    }
  })

  it('um registro que APAGARIA a capacidade é acusado como problema estrutural', () => {
    expect(problemasDoRegistro([completo({ capacidade: '' })])).toHaveLength(1)
    expect(problemasDoRegistro([completo({ autoridade_atual: DESCONHECIDO })])).toHaveLength(1)
    expect(capacidadePreservada({ capacidade: 'x', autoridade_atual: DESCONHECIDO })).toBe(false)
  })

  it('marcar OPERACIONAL sem sustentação é contradição, e o registro acusa', () => {
    const problemas = problemasDoRegistro([completo({ estado: 'OPERACIONAL', licenca_aprovada: false })])
    expect(problemas).toHaveLength(1)
    expect(problemas[0]).toContain('LICENCA_NAO_RESOLVIDA')
  })

  it('decidir INTEGRAR sem identidade resolvida é acusado', () => {
    expect(problemasDoRegistro([completo({ identidade_resolvida: false })]).join(' ')).toContain('sem identidade resolvida')
  })
})

describe('o registro REAL desta árvore', () => {
  const registro = JSON.parse(readFileSync(new URL('../docs/inventory/candidatos-v6.json', import.meta.url), 'utf8'))

  it('os candidatos registrados sao os quinze do pacote V6 mais os do ecossistema DSH', () => {
    // A contagem é literal de propósito: um candidato que entre sem linha aqui
    // é um candidato que ninguém reviu. Os quatro últimos vieram da diretiva do
    // titular de 18/09 — procurar no ecossistema DSH antes de reimplementar.
    const doEcossistema = registro.candidatos.filter(item => item.id.startsWith('CAND-DSH-') || item.id === 'CAND-VISION-USE')
    expect(doEcossistema).toHaveLength(4)
    expect(registro.candidatos).toHaveLength(19)
  })

  it('nenhum está operacional, e NENHUMA capacidade foi perdida', () => {
    // O resultado correto da fatia E0: decidiu-se sobre todos, instalou-se
    // nenhum, e nenhuma capacidade sumiu com a recusa.
    for (const candidato of registro.candidatos) {
      expect(promocao(candidato).promovivel, candidato.id).toBe(false)
      expect(promocao(candidato).capacidade_preservada, candidato.id).toBe(true)
    }
    expect(problemasDoRegistro(registro.candidatos)).toEqual([])
  })

  it('os três de identidade ambígua ficam SEPARADOS, e não resolvidos por semelhança de nome', () => {
    // `open-design` genérico do texto de origem NÃO é o `nexu-io/open-design`.
    // Tratá-los como o mesmo seria decidir sobre um projeto pelo nome de outro.
    const ambiguos = registro.candidatos.filter(item => item.identidade_resolvida !== true)
    expect(ambiguos.map(item => item.id).sort()).toEqual(['PEND-AGENTCONNECT', 'PEND-OPEN-DESIGN', 'PEND-OPENSQUAD'])
    const generico = registro.candidatos.find(item => item.id === 'PEND-OPEN-DESIGN')
    const real = registro.candidatos.find(item => item.id === 'CAND-OD')
    expect(generico?.proprietario_repositorio).toBe(DESCONHECIDO)
    expect(real?.proprietario_repositorio).toBe('nexu-io/open-design')
  })

  it('o que JÁ está em uso não vira candidato a adotar de novo', () => {
    // Adotar o MCP "de novo" criaria uma segunda autoridade de integração —
    // exatamente a segunda verdade que o §46 proíbe.
    const mcp = registro.candidatos.find(item => item.id === 'REF-MCP')
    expect(mcp?.estado).toBe('JA_EM_USO')
    expect(mcp?.autoridade_atual).toContain('Integration Hub')
  })

  it('todo candidato nomeia a lacuna — inclusive quando a lacuna é NENHUMA', () => {
    // "Nenhuma lacuna observada" é uma resposta, e é a mais honesta para metade
    // desta lista. Deixar o campo vazio faria parecer que ninguém perguntou.
    for (const candidato of registro.candidatos) {
      expect(typeof candidato.lacuna, candidato.id).toBe('string')
      expect(candidato.lacuna.trim().length, candidato.id).toBeGreaterThan(0)
    }
  })

  it('todo EM_ESTUDO tem plano de saída escrito ANTES do estudo', () => {
    // Entrar sem saber sair é decisão só de ida, e o §46 exige a estratégia de
    // saída como campo do registro, não como promessa futura.
    const estudo = registro.candidatos.filter(item => item.decisao === 'EM_ESTUDO')
    expect(estudo.map(item => item.id).sort()).toEqual([
      'CAND-DSH-BROWSER', 'CAND-DSH-IMAGE-VISION', 'CAND-DSH-PPT', 'CAND-LEMONADE', 'CAND-OD', 'CAND-VISION-USE',
    ])
    for (const candidato of estudo) expect(candidato.plano_saida, candidato.id).toContain('Obrigatório')
  })
})
