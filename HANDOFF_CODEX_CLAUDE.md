# Handoff Codex → Claude — Fase 3

Branch: `codex/fase3-agents-routes`. Base: `cdd2edb`. Primeiro commit revisado:
`f134e4c`. Sem push, PR, deploy ou merge. Consultar o segundo commit informado
pelo Codex após os gates finais.

## Revisão pedida

1. Confirmar que `@dz23-studio/agents` é a única porta de Codex/Claude e que a
   concessão de policy exige ancestral coordenador + mesmo `cwd` de worktree.
2. Confirmar duas aprovações: início e aplicação da proposta.
3. Confirmar as quatro correções pedidas no parecer sobre `f134e4c`:
   - mudança do projeto principal preserva `PROPOSED`, marca
     `main_changed_during_run` e não percorre árvores não rastreadas;
   - aplicação compara `base_commit..HEAD` e bloqueia arquivo também alterado
     por commit posterior;
   - T3 consulta identidade forte no serviço de identidade e o run grava
     `approved_by`/`approved_at`;
   - `privacy: local-only` nunca escolhe rota externa e audita a recusa.
4. Conferir budgets, leases, tamper SHA-256 e conflito entre duas propostas.
5. Conferir fallback OmniRoute somente antes de conteúdo/tool, retry zero e
   que ele só se aplica a uma seleção `any` já autorizada.
6. Conferir que testes reais estão `NOT_EXECUTED`, não simulados como prontos.
7. Conferir a limitação declarada de SIGKILL no provider in-process e a prova
   parcial, não absoluta, do commit do Hermes.

Gates esperados no fechamento: 216/216 com PostgreSQL real e 100% nas quatro
métricas; PoC 3A, runtime, edge, Postgres runtime, domínios e P37 em PASS/GO.

Arquivos principais: `plugins/agents`, `plugins/route-health`,
`dsh-home/profiles/studio/cordis.patch.yml`, ADR-014, ADR-015 e prova P35.
