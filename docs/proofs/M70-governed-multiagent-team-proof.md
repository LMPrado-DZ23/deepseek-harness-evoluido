# M70 — Equipe multiagente governada

Estado: **BETA**. Base anterior: `6706f16`; implementação isolada em
`codex/m70-multiagent-team`. Esta prova não autoriza merge na principal, push,
PR, deploy ou ativação de Docker.

## Capacidade implementada

- domínio físico `studio_agent_teams`, nome lógico `studio.agent.teams`, com
  registros persistentes de equipe e tarefas;
- DAG de 1 a 8 tarefas, com IDs únicos, rejeição de dependência inexistente,
  autorreferência, ciclo e sobreposição de caminhos entre tarefas que poderiam
  rodar juntas;
- quatro papéis fechados: implementação, revisão, teste e síntese;
- tarefas raiz independentes iniciadas na mesma rodada; dependentes só ficam
  elegíveis depois que todas as predecessoras forem `APPLIED` pela pessoa;
- sete ferramentas de equipe no Assistente, somadas às seis individuais;
- T2 para equipes comuns e T3 para `secrets`, `external-network` ou `deploy`;
- escopo, tenant, papel, repositório e allowlist derivados no servidor;
- somente provider `spawn-in-process`; cada tarefa continua usando o worktree,
  lease, orçamento, diff, revisão e aplicação de `StudioAgentService`;
- cancelamento de jobs vivos e tarefas ainda enfileiradas, sem apagar propostas
  já produzidas e sem aplicar qualquer diff.

## Prova no clone limpo

Clone ext4: `/home/leandro/dz23-gates/m70-7158d30`. Harness fixado em
`6c705be1ce6774a000d061da41d1823b03a3d42c`. Instalação congelada do upstream,
build oficial e instalação filtrada do Studio passaram antes da suíte.

`pnpm typecheck`: **PASS**.

`pnpm exec vitest run --coverage --maxWorkers=1`:

- 124 arquivos aprovados e 6 arquivos PostgreSQL pulados;
- 2.019 testes aprovados e 62 pulados por ausência de DSN nesta prova sem
  Docker;
- cobertura global: 96,10% statements, 93,53% branches, 96,63% functions e
  98,14% lines;
- `plugins/agent-team/src/model.ts` e `service.ts`: 100% em statements,
  branches, functions e lines;
- `plugins/assistant-bridge/src/catalog.ts`, `closed-tool.ts` e `service.ts`:
  100% no gate crítico conjunto.

Também foram provados entrada aninhada malformada, falha de provider que não é
objeto `Error`, falha ao persistir o vínculo de job, cancelamento concorrente,
serialização por equipe, dependência transitiva e conflito de caminhos.

## Limites honestos

- início automático de dependentes: `NOT_PRESENT`; a pessoa usa a ação
  governada de continuar depois de revisar e aplicar as propostas anteriores;
- Codex CLI, Claude Code e Hermes reais: `NOT_CONFIGURED`/`NOT_EXECUTED`;
- consenso e síntese automática: `NOT_PRESENT`; `synthesizer` é apenas um papel
  fechado de uma tarefa normal;
- aplicação automática de proposta: `NOT_PRESENT`;
- recuperação de jobs vivos após reinício: `NOT_PRESENT`;
- PostgreSQL físico e jornada de navegador com sessão real: `NOT_EXECUTED` nesta
  prova porque Docker permanece desligado por decisão do usuário.

M70 não transforma essas ausências em capacidade pronta e não altera o upstream
do DeepSeek Harness.
