# ADR-029 — Operação do Studio sobre PostgreSQL (P31-B)

Status: aceita e implementada na etapa M3 (Claude), sobre a base P31-A.

## Decisões

1. **Rotas de domínio têm fonte única.** Todo domínio declarado em
   `scripts/studio-domain-specs.ts` precisa de rota `postgres` nos patches
   `deploy/harness/edge.patch.yml` (produção) e `postgres-proof.patch.yml`
   (provas). O gate `pnpm gate:domain-routes` falha com qualquer domínio sem
   rota, rota desconhecida ou patch sem rota alguma. Antes desta ADR os oito
   domínios do Prompt-to-App caíam no backend `json` em produção sem que nenhum
   teste percebesse; a prova de runtime passa a confirmar cada unidade na
   tabela `units` do esquema, não apenas a abertura do domínio.
2. **Backup lógico a quente, no mesmo formato da migração.** O plugin
   `storage-postgres` expõe `snapshotPostgresStorage`: uma transação
   `REPEATABLE READ READ ONLY` lê `units`, `records` e `unit_globals` sem tomar o
   lock de escritor, produzindo um bundle `dz23-studio-kv-export/v1` — o mesmo
   que `storage:import-postgres` restaura. Não há dependência de `pg_dump` para o
   backup lógico; `pg_dump` continua sendo o backup físico do operador.
3. **Agendamento dentro do Studio.** Com `backupDirectory` configurado, o
   plugin grava `studio-backup-<carimbo>.json` (0600) + `.sha256` + ledger
   `backups.jsonl`, apaga só os seus próprios arquivos além de `backupKeep`,
   nunca derruba o Studio por falha de backup (registra e segue) e recusa
   intervalo menor que cinco minutos. O diretório é um volume dedicado no
   Compose (`studio-backups`). Sem diretório, não há agendamento e o operador usa
   `pnpm storage:backup-postgres`.
4. **Restauração é o caminho já provado.** `storage:import-postgres --write`
   importa num esquema de staging e troca atomicamente; recusa alvo com dados sem
   `--force --confirm REPLACE_DZ23_STORAGE`, recusa Studio em execução (lock de
   escritor) e faz `pg_dump` do esquema anterior antes de substituir.
5. **Instância de desenvolvimento migra do `json`.** O Harness padrão guarda os
   domínios em `<DSH_HOME>/storages` (json), não em SQLite; `storage:export-json`
   cobre esse caso com o Harness parado.
6. **Gate PostgreSQL sem Docker.** `pnpm test:postgres` usa
   `DZ23_POSTGRES_TEST_DSN` quando definido (qualquer PostgreSQL 16) e só cai no
   Compose descartável sem DSN; sem servidor imprime `POSTGRES_GATE=NOT_EXECUTED`
   e falha — pular integração nunca conta como aprovado.
7. **Saídas compiladas não são versionadas.** `plugins/*/lib` saiu do Git (havia
   cópias defasadas do código-fonte que o runtime carregava); toda prova de
   runtime roda depois de `pnpm build`.

## Consequências

- Provas: `prove:postgres-runtime` (20 unidades no esquema), `prove:postgres-soak`
  (operação contínua com backups a quente, contenda de escritor e `SIGKILL`),
  `prove:storage-migration` (json → PostgreSQL com dados das fatias 1–2).
- O que ainda falta para ESTÁVEL: Compose real executado num servidor (o
  ambiente do Claude não tem Docker: `NOT_EXECUTED` até o Codex rodar no WSL),
  restauração ensaiada em produção, observabilidade do lease e do backup na
  interface, RLS por tenant (segue `NOT_PRESENT`, ADR própria).
