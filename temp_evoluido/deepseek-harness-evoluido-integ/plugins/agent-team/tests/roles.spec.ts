/**
 * A-06 — os sete papéis (mais o que já existia), e o que cada um pode tocar.
 *
 * O teste que importa mais neste arquivo é o primeiro: a recusa de ferramenta
 * usa NOMES REAIS. O que existia antes era `deny: ['network']`, e não há
 * ferramenta chamada `network` no Harness — a recusa não removia nada, e a
 * proteção só existia na cabeça de quem lesse o código.
 */
import { describe, expect, it } from 'vitest'
import { AGENT_TEAM_ROLES, COORDINATOR_ROSTER, NETWORK_TOOLS, READ_TOOLS, ROLE_TOOL_POLICY, WRITE_TOOLS, roleToolRestriction, visibleTools } from '../src/roles.ts'
import { agentTeamRoleSchema } from '../src/model.ts'

describe('A-06 os papéis existem e cada um declara o que pode', () => {
  it('os SETE papéis do requisito existem', () => {
    for (const role of ['analyst', 'architect', 'designer', 'implementer', 'tester', 'security', 'reviewer']) {
      expect(AGENT_TEAM_ROLES).toContain(role)
    }
  })

  it('o esquema aceita exatamente os papéis declarados: nome sem poder definido não entra', () => {
    expect([...agentTeamRoleSchema.options].sort()).toEqual([...AGENT_TEAM_ROLES].sort())
    expect(agentTeamRoleSchema.safeParse('hacker').success).toBe(false)
  })

  it('TODO papel tem linha na tabela de poder: um papel sem linha é um buraco', () => {
    // Tabela, e não expressão. Foi assim que o piso do manifesto (D16) parou
    // de esquecer `filesystem.workspace`.
    expect(Object.keys(ROLE_TOOL_POLICY).sort()).toEqual([...AGENT_TEAM_ROLES].sort())
  })

  it('o papel que já existia continua existindo: apagá-lo quebraria toda equipe gravada que o usa', () => {
    expect(AGENT_TEAM_ROLES).toContain('synthesizer')
  })
})

describe('A-06 o papel muda as FERRAMENTAS, não só a frase', () => {
  it('a lista é de PERMISSÃO, e não de recusa: o que não está nela some', () => {
    // Uma lista de recusa erra fechado só para o que alguém lembrou de
    // escrever nela. Com permissão, a ferramenta nova não chega a papel nenhum
    // até alguém decidir que chega.
    for (const role of AGENT_TEAM_ROLES) {
      expect(roleToolRestriction(role, false)).toHaveProperty('allow')
      expect(roleToolRestriction(role, false)).not.toHaveProperty('deny')
    }
  })

  it('quem não escreve NÃO enxerga as ferramentas de escrita', () => {
    for (const role of ['analyst', 'architect', 'tester', 'security', 'reviewer', 'synthesizer'] as const) {
      const { allow } = roleToolRestriction(role, false)
      for (const tool of WRITE_TOOLS) expect(allow).not.toContain(tool)
      // E continua enxergando o que precisa para fazer o trabalho dele: ler.
      for (const tool of READ_TOOLS) expect(allow).toContain(tool)
    }
  })

  it('quem escreve enxerga as ferramentas de escrita QUE ESTAO MONTADAS', () => {
    for (const role of ['implementer', 'designer'] as const) {
      const { allow } = roleToolRestriction(role, true)
      // Só as do roster: `str_replace_editor` não está montada, e nomeá-la faria
      // o `tools.restrict()` do Harness LANÇAR e derrubar a delegação inteira.
      for (const tool of WRITE_TOOLS.filter(name => (COORDINATOR_ROSTER as readonly string[]).includes(name))) {
        expect(allow).toContain(tool)
      }
      expect(allow).not.toContain('str_replace_editor')
      // Com ela montada, entra.
      expect(roleToolRestriction(role, true, [...COORDINATOR_ROSTER, 'str_replace_editor']).allow).toContain('str_replace_editor')
    }
  })

  it('a permissao NUNCA nomeia ferramenta fora do roster: nomear a mais LANCA no Harness', () => {
    // `tools.restrict()` do Harness lança com nome desconhecido — não ignora.
    // Uma permissão que nomeia ferramenta ausente derruba TODA delegação no
    // nascimento, e a pessoa vê um erro interno opaco. Este é o teste que
    // impede o defeito de voltar.
    for (const role of AGENT_TEAM_ROLES) {
      for (const approved of [false, true]) {
        for (const name of roleToolRestriction(role, approved).allow) {
          expect(COORDINATOR_ROSTER, `${role}: ${name}`).toContain(name)
        }
      }
    }
  })

  it('um revisor e um construtor NÃO recebem a mesma coisa — que era o defeito', () => {
    expect(roleToolRestriction('reviewer', false).allow).not.toEqual(roleToolRestriction('implementer', false).allow)
  })

  it('a rede fica de fora por padrão, e a aprovação da equipe a inclui', () => {
    const closed = roleToolRestriction('implementer', false).allow
    for (const tool of NETWORK_TOOLS) expect(closed).not.toContain(tool)
    // E as de rede so entram quando ESTAO MONTADAS: o roster de hoje nao as
    // tem, e nomear ferramenta ausente faria o `tools.restrict()` do Harness
    // LANCAR e derrubar a delegacao inteira.
    const withWeb = [...COORDINATOR_ROSTER, ...NETWORK_TOOLS]
    for (const tool of NETWORK_TOOLS) expect(roleToolRestriction('implementer', true, withWeb).allow).toContain(tool)
    for (const tool of NETWORK_TOOLS) expect(roleToolRestriction('implementer', true).allow).not.toContain(tool)
  })

  it('SEGURANÇA não fala com a rede NEM com a equipe aprovada para rede externa', () => {
    // É o último papel que deveria conseguir telefonar para fora com o código
    // na mão. A aprovação da equipe não alcança aqui.
    const approved = roleToolRestriction('security', true, [...COORDINATOR_ROSTER, ...NETWORK_TOOLS]).allow
    for (const tool of NETWORK_TOOLS) expect(approved).not.toContain(tool)
    for (const tool of WRITE_TOOLS) expect(approved).not.toContain(tool)
    expect(approved).toEqual([...READ_TOOLS].sort())
  })

  it('a permissão usa NOMES REAIS do Harness, e a palavra inventada `network` não aparece em lugar nenhum', () => {
    // `toolFilter` filtra por nome de ferramenta global. `network` não é uma:
    // `deny: ['network']` removia exatamente nada.
    for (const role of AGENT_TEAM_ROLES) {
      for (const approved of [false, true]) expect(roleToolRestriction(role, approved).allow).not.toContain('network')
    }
    expect([...NETWORK_TOOLS]).toEqual(['web_search', 'web_fetch'])
    expect([...WRITE_TOOLS]).toEqual(['write', 'edit', 'str_replace_editor'])
    expect([...READ_TOOLS]).toEqual(['read', 'read_image'])
  })

  it('a lista sai ordenada e sem repetição: ela é comparada, não só usada', () => {
    for (const role of AGENT_TEAM_ROLES) {
      for (const approved of [false, true]) {
        const { allow } = roleToolRestriction(role, approved)
        expect(allow).toEqual([...allow].sort())
        expect(new Set(allow).size).toBe(allow.length)
      }
    }
  })
})

describe('A-06 a cobertura é conferida contra o roster REAL', () => {
  it('um papel de leitura não enxerga nada que escreva, HOJE nem depois de o roster crescer', () => {
    const readOnly = roleToolRestriction('reviewer', false)
    // O roster de hoje: o preset `dz23-coordinator-in-process` monta só `tool-fs`.
    expect(visibleTools(readOnly, ['read', 'read_image', 'write', 'edit'])).toEqual(['read', 'read_image'])
    // O dia em que alguém montar `tool-bash` ali: a ferramenta nova NÃO chega
    // ao revisor, e ninguém precisou lembrar de recusá-la.
    expect(visibleTools(readOnly, ['read', 'read_image', 'write', 'edit', 'bash', 'web_search'])).toEqual(['read', 'read_image'])
  })

  it('e o construtor enxerga o que precisa desse mesmo roster', () => {
    expect(visibleTools(roleToolRestriction('implementer', false), ['read', 'read_image', 'write', 'edit']))
      .toEqual(['read', 'read_image', 'write', 'edit'])
  })
})
