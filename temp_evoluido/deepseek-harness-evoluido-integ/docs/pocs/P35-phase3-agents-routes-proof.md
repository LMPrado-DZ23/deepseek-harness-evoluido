# P35 — Prova da Fase 3: rotas e agentes

Base: `codex/p30-policy-foundation@cdd2edb`; upstream
`6c705be1ce6774a000d061da41d1823b03a3d42c`. Execução canônica em WSL2/ext4.

## Resultado

PoC 3A: **GO** para composição in-process e isolamento. O Harness real carregou
`deepseek-official`, `omniroute`, `ollama` e `studio-fake`; 9Router ficou ausente.
Também registrou os providers oficiais `codex` e `claude-code`, sem expor a
ferramenta genérica de delegação.

A sessão coordenadora recebeu o caminho exato do worktree. A escrita aprovada
ocorreu somente na cópia; hash da árvore, status e arquivo do checkout principal
permaneceram iguais. Tentativa `../` foi bloqueada e ferramenta filtrada não foi
executada. A sessão interna foi descartada e a proposta preservada como diff.

O teste Git real aplica a primeira proposta revisada, cria um commit no projeto
principal e recusa uma segunda proposta da mesma base que toca o mesmo arquivo.
Também bloqueia diff adulterado e mudança local concorrente. Uma mudança no
projeto principal durante a execução não culpa o agente nem elimina seu trabalho:
a proposta fica `PROPOSED`, marcada com `main_changed_during_run: true`, e o
conflito é decidido somente na aplicação.

T3 consulta a identidade autoritativa e exige passkey recente mesmo quando o
objeto de aprovação diz `approved: true`; cada run grava `approved_by` e
`approved_at`. A seleção de rota exige privacidade explícita: `local-only` com
Ollama indisponível retorna nenhuma rota e grava a recusa, sem fallback externo.

## Gates executados

- `pnpm typecheck`: PASS;
- `pnpm test:coverage`: PASS, 198 testes; 18 PostgreSQL explicitamente pulados
  nesta execução sem DSN; 100% nas quatro métricas da lógica determinística;
- `pnpm build`: PASS;
- `pnpm prove:fase3-agents`: GO;
- `pnpm preflight:fase3`: PASS como diagnóstico, sem instalação/start.

Com PostgreSQL 16 real, `pnpm test:postgres:coverage` aprovou **216/216** com
100% nas quatro métricas. A prova de reinício confirmou os **12** domínios
`studio_*` roteados para Postgres; o backend padrão dos domínios upstream segue
JSON.

Preflight observado: Codex `NOT_PRESENT`, Claude `OK`, Ollama `DOWN`, OmniRoute
`NOT_CONFIGURED`. Os testes reais `DZ23_REAL_CODEX=1` e
`DZ23_REAL_CLAUDE=1` não foram solicitados e permanecem `NOT_EXECUTED`.

## Limitações honestas

- Nenhum agente CLI real foi executado nesta rodada.
- `spawn-in-process` não possui processo filho para receber SIGKILL; a perda foi
  injetada no contrato e classificada `FAILED`.
- Nenhum diff foi aplicado automaticamente, nenhum push/PR/deploy/merge ocorreu.
- A rota de saúde foi validada deterministicamente; nenhum provedor pago ou
  externo foi chamado.
