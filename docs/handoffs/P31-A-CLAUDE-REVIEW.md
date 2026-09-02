# P31-A — handoff para revisão do Claude

Data: 2026-09-02
Produto: DZ23 STUDIO
Revisão pedida: somente leitura, antes de qualquer merge

## Identidade exata

- repositório: `work/poc-01-studio`;
- branch: `codex/p31a-storage-postgres`;
- base congelada: `391c06181ebb51b0d270692400f0cac13c48f8c8`;
- Harness upstream: `/home/leandro/harness-studio-poc02/deepseek-harness`;
- pin upstream: `6c705be1ce6774a000d061da41d1823b03a3d42c`;
- escopo do diff: `391c061..codex/p31a-storage-postgres`;
- não houve push, PR, merge ou deploy.

Antes da revisão, registrar `git rev-parse HEAD` e confirmar árvore limpa. O
commit final é informado também na mensagem de encaminhamento; não se grava o
próprio hash dentro do mesmo commit para evitar uma referência circular.

## O que foi construído

1. `@dz23-studio/storage-postgres`, composto pelo seam público de storage:
   credencial por `dsnRef`, schema versionado, PostgreSQL 16 por digest, pool de
   bootstrap limitado e uma conexão dedicada por unidade.
2. Escritor único cross-process com advisory lock mantido pela conexão, heartbeat
   somente diagnóstico e falha fechada `unit-locked` após perda da sessão.
3. Roteamento somente dos nove domínios físicos `studio_*`; backend padrão e
   domínios upstream continuam em JSON.
4. Gate AST sem wildcard que exige classificação de tenant para toda tabela
   declarada por `defineDomain`.
5. Exportação SQLite lógica e importação PostgreSQL dry-run por padrão, bundle
   versionado/checksummed, staging, verificação, backup obrigatório e confirmação
   forte para substituição.
6. Compose de teste descartável e Compose de servidor sem porta PostgreSQL
   publicada.
7. Artefatos `lib/` reproduzidos pelo `pnpm build` para identity, tenancy,
   policy e storage-postgres. Identity/tenancy já apontavam `main` para `lib/`,
   mas esses arquivos não estavam versionados na base; não houve mudança nos
   respectivos fontes nesta fatia.

## Evidência a conferir

Executada em WSL2/ext4 numa cópia descartável da árvore final:

- instalação raiz e perfil com `pnpm 11.7.0 --frozen-lockfile`: PASS;
- `pnpm typecheck`: PASS;
- `pnpm build`: PASS;
- `pnpm gate:domain-scopes`: PASS;
- `pnpm test`: 156 PASS, 17 PostgreSQL SKIPPED por DSN ausente;
- `pnpm test:coverage`: 156 PASS e 100% nos plugins não dependentes de PG;
- `pnpm test:postgres:coverage`: 173/173 PASS, 100% statements, branches,
  functions e lines, inclusive `storage-postgres`;
- `pnpm test:postgres:runtime`: GO, nove domínios em PostgreSQL e persistência
  depois de reinício;
- `pnpm prove:runtime`: GO;
- `pnpm prove:edge`: GO;
- `docker compose config -q`: PASS;
- gate P37 de licenças e caminhos proibidos: PASS.

Casos PostgreSQL incluem o contrato KV upstream importado diretamente, dois
processos Node reais, `SIGKILL`, `pg_terminate_backend`, incompatibilidade de
versão, dois tenants na mesma base, SQLite real → PostgreSQL e alvo ocupado.

## Pontos de revisão prioritários

1. Confirmar que heartbeat antigo nunca concede autoridade e que só o advisory
   lock da conexão dedicada permite escrita.
2. Procurar qualquer caminho que aceite operação depois da perda da conexão ou
   promova um segundo processo a standby quente.
3. Conferir ausência de DSN em YAML, logs, bundle de migração e argumentos CLI.
4. Revisar atomicidade do layout/staging/cutover e as confirmações de destruição.
5. Confirmar que o gate de tenant é descrito como aplicação/modelo, nunca como
   RLS de banco.
6. Conferir que `storage-domain` ainda impede CAS, batch, transação de negócio,
   multi-instância ativa e RLS; esses limites devem continuar explícitos.
7. Revisar o limite de 40 caracteres do schema, que reserva espaço para o sufixo
   de staging abaixo do limite PostgreSQL de 63 bytes.

## Duas precisões em relação ao brief inicial

- Heartbeat com mais de 60 segundos **não** permite takeover se a advisory lock
  ainda existe. A linha é diagnóstico; remover ou ignorar a trava pela idade
  criaria dois escritores. Essa precisão de segurança substitui a frase
  “lease órfã pode ser tomada” do brief.
- O layout usa uma tabela normalizada `records(unit, table_name, key, value)` em
  vez de criar `u_<unit>_<table>` por DDL. `UNIT_NAME_RE` não limita tamanho e o
  PostgreSQL trunca identificadores acima de 63 bytes; o layout literal poderia
  colidir nomes válidos. O modelo normalizado preserva o contrato KV, evita
  identificadores derivados e mantém cada mutação em um statement. Pedimos que
  o Claude julgue explicitamente esta correção arquitetural, pois ela difere do
  detalhe físico assumido no prompt sem mudar a API pública.

## Classificação honesta

GO apenas para backend KV PostgreSQL **BETA** e escritor único. Alta
disponibilidade, standby quente, RLS, transações de negócio, carga, servidor real
e restore operacional continuam `BLOCKED`, `NOT_PRESENT` ou `NOT_EXECUTED`
conforme ADR-013 e a matriz.

## Saída esperada do Claude

Parecer com incompatibilidades concretas classificadas por severidade e
referência de arquivo/linha. Se não houver ALTA ou MÉDIA, autorizar merge local
da branch em `codex/p30-policy-foundation`. Não autorizar push, PR ou deploy.
