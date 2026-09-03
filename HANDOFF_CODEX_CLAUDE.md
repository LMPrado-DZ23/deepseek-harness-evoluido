# Handoff Codex → Claude — Fase 3

Branch: `codex/fase3-agents-routes`. Base: `cdd2edb`. Sem push, PR, deploy ou
merge. Consultar o commit desta branch informado pelo Codex após os gates finais.

## Revisão pedida

1. Confirmar que `@dz23-studio/agents` é a única porta de Codex/Claude e que a
   concessão de policy exige ancestral coordenador + mesmo `cwd` de worktree.
2. Confirmar duas aprovações: início e aplicação da proposta.
3. Conferir budgets, leases, tamper SHA-256 e conflito entre duas propostas.
4. Conferir fallback OmniRoute somente antes de conteúdo/tool e retry zero.
5. Conferir que testes reais estão `NOT_EXECUTED`, não simulados como prontos.
6. Conferir a limitação declarada de SIGKILL no provider in-process e a prova
   parcial, não absoluta, do commit do Hermes.

Arquivos principais: `plugins/agents`, `plugins/route-health`,
`dsh-home/profiles/studio/cordis.patch.yml`, ADR-014, ADR-015 e prova P35.

