# P31-A — prova do backend PostgreSQL

Data: 2026-09-02
Estado: **BETA / implementação em revisão, sem merge**

## Base

- Studio: branch `codex/p31a-storage-postgres`, base `391c061`;
- Harness upstream: `6c705be1ce6774a000d061da41d1823b03a3d42c`, sem alterações;
- PostgreSQL: `postgres:16-alpine`, digest
  `sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685`;
- driver `pg` 8.23.0 e tipos 8.23.1, ambos MIT e fixados;
- execução: WSL2/Linux, contêiner sem porta fixa e com dados em tmpfs.

## Evidência executada

`pnpm test:postgres:coverage` passou **173/173 testes** em 14 arquivos, incluindo
os gates anteriores e 17 casos PostgreSQL. A cobertura final foi **100%** em
statements, branches, functions e lines para todos os plugins. Entre os casos reais:

- os cinco testes importados diretamente de `runKvBackendContract`;
- durabilidade após fechamento e reabertura;
- versão de unidade e versão do layout incompatíveis;
- nomes inválidos antes de tocar o banco;
- dois processos Node reais disputando a mesma unidade;
- primeiro processo morto com `SIGKILL`, segundo adquirindo a trava depois;
- conexão do holder terminada por `pg_terminate_backend`, operação antiga
  recusada como `unit-locked`;
- duas organizações na mesma base e filtro adversarial do serviço;
- SQLite real com os nove domínios e registros de identidade/tenancy → bundle
  lógico com SHA-256 → PostgreSQL vazio → releitura registro a registro idêntica;
- importação sobre unidade ocupada recusada.

Também passaram `typecheck`, build de todos os plugins, gate de domínios e a
suíte sem Docker. Sem Docker, os testes PostgreSQL são marcados como não
executados e os demais 156 testes passam; essa execução não é usada para fingir
cobertura do backend.

As provas de processo completo, executadas numa cópia descartável em ext4,
também passaram:

- `pnpm test:postgres:runtime`: Harness real iniciou com backend `postgres`,
  manteve `json` como backend padrão, roteou exatamente nove domínios
  `studio_*` e restaurou `studio_hello` depois de encerrar e iniciar de novo;
- `pnpm prove:runtime`: PoC-01b continuou GO, inclusive aprovação, sandbox,
  sessão, identidade, tenancy e persistência;
- `pnpm prove:edge`: P29-C continuou GO para HTTP, RPC e WebSocket através do
  Caddy, com cerca interna, rate limit e cabeçalhos de segurança;
- instalação raiz e do perfil com `--frozen-lockfile`, `docker compose config`
  e o gate P37 de licença/proibições passaram.

## Interpretação correta

É GO para backend KV BETA e NO-GO para declarar alta disponibilidade,
multi-instância ativa, transações de negócio ou RLS. O processo concorrente é
recusado; não é promovido a standby quente. A causa é o contrato atual do
`storage-domain`, documentada na ADR-013 e no rascunho upstream.

O caminho operacional completo de importação com `pg_dump` e restore de um
dataset real permanece `NOT_EXECUTED`. O E2E desta fase cobriu SQLite real,
bundle com checksums, staging PostgreSQL, releitura e recusa de alvo ocupado.

Nada foi enviado, publicado ou implantado.
