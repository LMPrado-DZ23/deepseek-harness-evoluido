# Prova M72-A — PostgreSQL 16 real: RLS por inquilino e três defeitos encontrados

Autor: Claude (Opus 5) — 07/09/2026. Base: `claude/m90a-action-approval@1e4767e`
(que descende de `codex/m90-action-approval@4c44218` = M89 `f1677b4`).

## O que mudou de verdade aqui

Até hoje a suíte de PostgreSQL do projeto estava marcada `NOT_CONFIGURED` em
todo relatório meu e `BETA` nos do Codex. Ela **nunca tinha sido executada
contra um banco real** nesta linha. Agora foi:

```
DZ23_POSTGRES_TEST_DSN=postgresql://dz23_test:***@127.0.0.1:5432/dz23_test
node scripts/test-postgres.mjs
→ Test Files 6 passed (6) · Tests 60 passed (60)
```

PostgreSQL 16.13 real, base descartável, credencial só de teste.

E rodar de verdade encontrou **três defeitos** que nenhum teste em memória
poderia ter encontrado.

## Defeito 1 (ALTA) — o backup de segurança não conseguia conectar

`postgresDumpInvocation` entregava o alvo assim:

```ts
environment: { ...target.env, PGDATABASE: target.dsn }   // target.dsn é uma URI
```

**libpq só expande uma URI no parâmetro `dbname` que recebe explicitamente.**
Uma URI colocada em `PGDATABASE` é tratada como *nome de banco*. Sem `PGHOST`,
`PGUSER` e `PGPORT`, o `pg_dump` cai nos padrões: socket local e usuário do
sistema operacional.

Reproduzido nesta máquina:

```
PGDATABASE='postgresql://dz23_test@127.0.0.1:5432/dz23_test' pg_dump --schema=… 
→ FATAL: role "root" does not exist        (exit 1)

PGHOST=127.0.0.1 PGPORT=5432 PGUSER=dz23_test PGDATABASE=dz23_test pg_dump …
→ exit 0, 2816 bytes
```

Aqui falhou fechado, e nada foi perdido. **Mas o modo de falha depende da
máquina.** Num servidor onde o padrão por acaso conecta — um contêiner oficial
do PostgreSQL, em que existe um papel com o nome do usuário do sistema e um
banco padrão — o `pg_dump` teria conectado no **banco errado**, produzido um
arquivo válido, e o restore destrutivo teria seguido em frente confiando nesse
"backup de segurança". Isso é perda de dado apresentada como sucesso.

**Correção:** `postgresToolConnection` passa a decompor o alvo em `PGHOST`,
`PGPORT`, `PGUSER` e `PGDATABASE`. **Nada do alvo entra em `argv`** — a
política existente do projeto (que tem teste próprio: "never puts the password
or the TLS policy on the pg_dump command line") continua valendo, agora sem o
efeito colateral de não conectar.

## Defeito 2 (MÉDIA) — a suíte tinha asserções mortas

`postgres.spec.ts` afirmava `backup` e `backupStatus`; o relatório real do
restore chama esses campos de `safetyBackup` e `safetyBackupStatus` (é o que
`restore.ts` declara e o que `restore-journal.spec.ts` já usava). Duas
asserções sobre campos **que não existem** — `toMatchObject` reprovando por
motivo nenhum relacionado ao comportamento.

Isso é a prova de que a suíte não rodava: um `rename` passou por ela sem que
ninguém percebesse, porque sem DSN ela é pulada.

## Defeito 3 (BAIXA) — teste frágil por formato de tipo

`pg_policies.roles` é `name[]`, e o driver não converte `name[]` em arranjo
JavaScript em toda versão: chegava a string `{rls_runtime_…}`. Um `::text[]`
fixa o tipo, para o teste reprovar por **política errada** e nunca por formato.

## Melhoria de diagnóstico

`pg_dump` falhava com `pg_dump failed with code 1` **e mais nada** — a saída de
erro era descartada. Quem opera recebia um beco sem saída exatamente na hora em
que precisa entender por que o backup não saiu. Agora a última linha do erro é
capturada, limitada a 2 KB, tem os caminhos absolutos reduzidos ao nome do
arquivo e entra na mensagem.

## RLS por inquilino — provado contra PostgreSQL real

`tenant-store.postgres.spec.ts` agora passa e prova, **no banco**:

- `relrowsecurity = true` **e** `relforcerowsecurity = true` na tabela
  `tenant_records` — forçado inclusive para o dono da tabela;
- a política `tenant_scope` existe e está ligada exatamente ao papel de runtime;
- leitura e escrita **fora do escopo da transação** são recusadas pelo próprio
  PostgreSQL com `42501`, não pela aplicação.

É a diferença entre "o código filtra por `tenant_id`" e "o banco recusa".

## Gates executados

- suíte de PostgreSQL real: **6 arquivos, 60 testes, 0 falhas**
- suíte raiz completa **com PostgreSQL habilitado**: **2155 aprovados**,
  3 reprovados
- coverage (agora incluindo `plugins/storage-postgres`, que só entra no escopo
  quando há DSN): statements 95,66% · branches 92,77% · functions 95,53% ·
  lines 97,85% — **zero violação de limiar**
- `tsc --noEmit` **PASS**; `pnpm build` **PASS**

As 3 reprovações são as guardas de permissão POSIX do `builder-supervisor`
derrotadas pelo uid 0 do container; como usuário sem privilégio passam 103/103.

## O que isto NÃO prova

Uma instância só, local, na mesma máquina. **Não** prova multi-instância, **não**
prova servidor remoto, **não** prova TLS real (`--ssl off` no teste), e **não**
prova a operação num Windows. O estado continua **BETA** para
"Domínios Studio em PostgreSQL"; o que mudou é que agora existe prova física de
RLS e do caminho de restore nesta geração, e três defeitos a menos.

## Uma lição que vale registrar

Um teste que só roda quando uma variável de ambiente existe é um teste que
**não roda**. Os três defeitos estavam ali há tempo, atrás de um `skip`.
