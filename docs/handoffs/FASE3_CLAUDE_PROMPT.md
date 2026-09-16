# Fase 3 — registro vinculante para revisão Claude

Executar sobre `cdd2edb`, upstream `6c705be`, sem alterar upstream, push, PR,
deploy ou merge. Aplicam-se as decisões 1–6 do prompt de 03/09/2026 e a correção
do Claude: sessão coordenadora interna criada com `cwd` do worktree; providers
reais sem `agentOptions`, `outputSchema`, `maxDepth`, `toolFilter` ou `persona`;
profundidade 1 garantida pelo Studio; OmniRoute com retry zero.

Revisar especialmente ADR-014, ADR-015, prova P35, prova Hermes 7.6, isolamento
do PoC 3A e distinção entre teste determinístico e CLI real `NOT_EXECUTED`.

O segundo commit deve fechar o parecer Claude sobre `f134e4c`: mudança
concorrente do projeto principal é aviso, conflito considera commits desde a
base, T3 exige identidade forte consultada no trust plane, e `local-only` não
possui fallback externo. Confirmar no código e nos testes, sem reabrir o mérito.
