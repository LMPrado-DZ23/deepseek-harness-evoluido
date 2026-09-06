# ADR-035 — Repositório PostgreSQL tenant-aware e RLS

Status: fundação BETA, ainda não ligada aos domínios de produto  
Data: 2026-09-06

## Problema

O seam KV do Harness abre uma unidade inteira e o `storage-domain` mantém essa
unidade em memória. Suas operações não recebem organização ou tenant. Embora os
valores Studio carreguem campos de escopo e os serviços façam autorização, o
PostgreSQL enxerga somente JSON opaco; tentar adicionar uma policy ao layout KV
não produziria isolamento por requisição e seria uma alegação falsa de RLS.

## Decisão

O plugin `storage-postgres` passa a oferecer, de forma opcional, um repositório
paralelo cujo escopo é argumento obrigatório de cada operação. Ele usa uma
tabela normalizada com `org_id` e `tenant_id` como colunas físicas e instala o
escopo por `set_config(..., true)` dentro da mesma transação que lê ou altera os
dados. A policy aplica `USING` e `WITH CHECK`; sem os dois settings, nenhuma
linha é visível.

Administração e runtime usam credenciais diferentes:

- a credencial administrativa cria a tabela, habilita e força RLS, instala a
  policy e concede somente DML;
- a credencial de runtime precisa ser `NOSUPERUSER`, `NOBYPASSRLS`,
  `NOCREATEROLE` e `NOCREATEDB`, não pode ser dona da tabela nem herdar a role
  dona, criar no schema ou acessar outras relações dele, e deve apontar para o
  mesmo servidor e banco;
- usar a mesma referência de credencial para os dois papéis falha no startup.

A criação e a atualização da policy são serializadas por advisory lock
transacional do próprio PostgreSQL. Isso evita corrida de DDL quando duas
instâncias sobem ao mesmo tempo; não transforma o estado autoritativo em
ativo/ativo.

O cliente não fornece escopo. Quando um domínio migrar, ele receberá
`orgId`/`tenantId` exclusivamente da sessão autenticada no servidor. A API do
repositório não oferece operação sem escopo nem SQL arbitrário.

## Migração gradual

Esta fatia não troca a autoridade de nenhum domínio existente. Cada domínio
será migrado em commit próprio, com backfill verificável, contagens e hashes,
rollback e teste adversarial no PostgreSQL real. Até o primeiro consumidor ser
migrado, “RLS nos domínios de produto” continua `NOT_PRESENT`.

Ordem recomendada: projetos/AppSpec/design/plano/run/evidência/aprovação;
integrações e agentes; organizações/workspaces/memberships; identidade por
último, porque credenciais, passkeys e sessões têm escopos diferentes.

## Limites

- O teste físico PostgreSQL está implementado, mas permanece `NOT_EXECUTED`
  enquanto o Docker estiver desligado.
- RLS protege contra consultas de aplicação sem filtro. A credencial
  administrativa continua sendo segredo de alto impacto e nunca pertence ao
  processo runtime depois que a migração operacional for concluída.
- A credencial de runtime ainda consegue escolher um escopo usando
  `set_config`; portanto, RLS reduz falhas acidentais e SQL sem filtro, mas não
  torna seguro um processo runtime comprometido nem substitui autorização no
  serviço. Essa limitação é inerente ao modelo de uma única role atendendo
  vários tenants e deve permanecer explícita.
- A fundação não significa ativo/ativo, transação entre domínios ou produto
  multi-tenant estável.
