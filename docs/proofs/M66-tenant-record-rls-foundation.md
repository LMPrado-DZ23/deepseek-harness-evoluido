# M6.6 — Fundação tenant-aware com RLS PostgreSQL

Estado: **IMPLEMENTED / BETA FOUNDATION**. Domínios de produto ainda não usam
esta tabela.

## Evidência executada sem Docker

- testes unitários: **6/6 PASS**;
- `tenant-store.ts`: **100%** statements, branches, functions e lines;
- typecheck agregado: **PASS**;
- suíte completa em staging cumulativo M6.5+M6.6: **1.903 PASS / 62 SKIP /
  0 FAIL** em 118 arquivos aprovados e 6 pulados;
- pacote `storage-postgres`: **171 PASS / 60 SKIP**;
- build do pacote, typecheck agregado, gate de portabilidade e gate de i18n
  (**290 chaves**) aprovados;
- policy contém `USING` e `WITH CHECK` para organização e tenant;
- RLS é `ENABLE` + `FORCE` e a tabela revoga privilégios de `PUBLIC`;
- DDL da tabela e da policy é serializado por advisory lock transacional;
- credencial privilegiada, dona/herdeira da tabela ou apontando para outro
  banco é recusada;
- falha de operação executa rollback, libera a conexão e preserva o erro
  original;
- nomes, escopos, chaves e JSON inválidos falham antes do SQL.

## Prova física preparada, não executada

`plugins/storage-postgres/tests/tenant-store.postgres.spec.ts` cria uma role
descartável sem privilégios, grava dois tenants, comprova que cada escopo só
lista sua linha, comprova que uma conexão sem escopo vê zero linhas e exige erro
PostgreSQL `42501` quando o tenant A tenta inserir uma linha do tenant B. Também
consulta `pg_class`/`pg_policies` para verificar `relrowsecurity`,
`relforcerowsecurity` e a role exata da policy.

Esse teste está **SKIP / NOT_EXECUTED** neste checkpoint porque
`DZ23_POSTGRES_TEST_DSN` não foi fornecida e o Docker permanece desligado por
decisão do operador. Portanto ainda não existe alegação de RLS físico aprovado.

A suíte completa citada acima foi executada numa cópia WSL cumulativa que já
continha a M6.5. Ela prova compatibilidade entre as duas fatias; os testes
focados, o typecheck e o build do pacote foram executados diretamente contra a
M6.6.

## Próximo gate

1. revisão independente do contrato e da SQL;
2. execução da prova em PostgreSQL 16 real;
3. provisionamento operacional da segunda credencial sem segredo em Git;
4. migração de um domínio não crítico com backfill e rollback;
5. somente depois atualizar “RLS nos domínios de produto” de `NOT_PRESENT`.
