# DZ23 STUDIO

Produto local composto sobre os seams públicos do DeepSeek Harness sem alterar o
upstream. O nome oficial e o logotipo foram decididos pelo proprietário em
[ADR-003](./docs/adr/ADR-003-product-identity-dz23-studio.md).

O checkout de execução continua fixado no commit
`6c705be1ce6774a000d061da41d1823b03a3d42c`. O núcleo atual reúne policy,
identidade, tenancy, borda Caddy e o backend PostgreSQL BETA pelos seams públicos
do Harness; decisões de segurança não dependem da interface.

O produto será **open source e sem cobrança, assinatura, créditos ou paywall**.
A licença OSI exata ainda precisa ser escolhida antes da publicação; enquanto
`LICENSE.md` não for substituído, o checkout continua juridicamente privado.

## Decisão

**O gate literal original foi encerrado com errata aceita.** O commit fixado rejeita o nome físico `studio.hello`: `defineDomain` aceita somente `/^[a-z][a-z0-9_]*$/`. A convenção geral agora usa `studio_hello` como identificador físico e `studio.hello` como nome lógico.

**Viabilidade arquitetural do núcleo aprovada.** O PoC-01b executado em WSL2 ext4 comprovou sessão live, aprovação, sandbox com negação fora do workspace e preservação após reinício.

O P29-C também comprovou a borda Caddy autenticada para HTTP, RPC e WebSocket.
Essa capacidade está em **BETA**: não houve deploy, domínio ACME real nem teste em
celular físico. Consulte [ADR-012](./docs/adr/ADR-012-single-caddy-edge.md), a
[prova P29-C](./docs/pocs/P29-C-edge-proof.md), a
[matriz de capacidades](./docs/CAPABILITY_MATRIX.md) e o
[guia de acesso móvel](./docs/guides/mobile-secure-access.md) e o
[guia de cópia de segurança e restauração](./docs/guides/backup-e-restauracao.md).

Em servidor, `DZ23_BOOTSTRAP_OWNER_EMAIL` é obrigatório: somente esse endereço
pode criar a primeira conta proprietária. A borda autenticada também desativa o
modo pessoal no núcleo, ainda que o Harness permaneça em loopback.

O P31-A acrescenta PostgreSQL 16 para os domínios próprios `studio_*`, sem
mudar o backend padrão dos domínios oficiais do Harness. O banco não publica
porta e um segundo escritor da mesma unidade falha fechado. Isso ainda não é
alta disponibilidade, RLS ou multi-instância ativa; consulte a
[ADR-013](./docs/adr/ADR-013-postgres-kv-single-writer-and-migration.md) e a
[prova P31-A](./docs/pocs/P31-A-storage-postgres-proof.md).

A Fase 3 compõe DeepSeek direto, OmniRoute opcional e Ollama local, com saúde
por rota e sem 9Router. Delegações usam uma cópia Git isolada, pedem confirmação
antes de iniciar e outra antes de aplicar. O PoC in-process passou; Codex e
Claude Code reais continuam `NOT_EXECUTED`. Consulte
[ADR-014](./docs/adr/ADR-014-model-routes-and-health.md),
[ADR-015](./docs/adr/ADR-015-isolated-agents.md) e a
[prova P35](./docs/pocs/P35-phase3-agents-routes-proof.md).

A fatia 2 gera dados, formulários, acesso e painel CRUD sobre `node:sqlite`.
Envios comuns podem ser públicos, mas listas de cadastros nunca são públicas;
dados sensíveis exigem acesso também no envio.
Esquema, migrações, repositórios, auth, sessão, CSRF e ações são protegidos e
nunca vêm do modelo. As provas executaram cadastro/lista e o ciclo completo
login→criar→editar→excluir em contêiner sem rede. Consulte as ADRs
[023](./docs/adr/ADR-023-generated-sqlite-data-layer.md),
[024](./docs/adr/ADR-024-generated-passwordless-access.md),
[026](./docs/adr/ADR-026-form-database-category.md) e
[027](./docs/adr/ADR-027-crud-panel-category.md), além da
[prova de acesso e CRUD](./docs/proofs/P32-auth-crud-proof.md).

Consulte [REPORT.md](./REPORT.md) para comandos, resultados, erros e limitações.

Decisões relacionadas:

- [ADR-001 — identificadores físicos e nomes lógicos](./docs/adr/ADR-001-storage-domain-naming.md)
- [ADR-016 / E4 — usabilidade depois do produto completo](./docs/adr/ADR-016-errata-e4-phase05-order.md)
- [Plano Mestre v2.0 consolidado](./docs/PLANO_MESTRE_v2_HARNESS_STUDIO.md)
- [BASELINE-001 — DeepSeek Harness 6c705be](./docs/baselines/BASELINE-001-deepseek-harness-6c705be.md)
- [PoC-01b — prova viva do núcleo no WSL2 ext4](./docs/pocs/POC-01B-runtime-proof.md)

## Estrutura

- `dsh-home/profiles/studio`: profile Studio que estende os bundles oficiais `@deepseek-ai/dsh-base` e `@deepseek-ai/dsh-web-app`.
- `plugins/hello`: plugin externo `@studio/hello`; o upstream não recebe arquivos ou alterações.
- `plugins/policy`: motor TypeScript + Zod dos tiers T0–T3, com auditoria por sessão.
- `plugins/identity`: passkeys, código temporário por e-mail, sessões opacas,
  dispositivos, CSRF e revogação ligados ao motor de permissões.
- `plugins/storage-postgres`: persistência KV PostgreSQL, lock cross-process e
  falha fechada após perda da conexão autoritativa.
- `plugins/route-health`: saúde, uso, custo e fallback seguro por rota.
- `plugins/agents`: delegação aprovada em worktree, budgets, leases e propostas.
- `apps/studio-web/public/brand`: identidade visual oficial do DZ23 STUDIO.
- `deploy/caddy`: borda única, login simples e configurações TLS separadas para
  servidor e uso local.
- `UPSTREAM.lock`: identidade do repositório e commit usados.

## Verificação focada

No WSL Ubuntu, a partir da raiz deste repositório:

```sh
pnpm typecheck
pnpm test:coverage
pnpm gate:domain-routes
pnpm build
# PostgreSQL: DZ23_POSTGRES_TEST_DSN aponta para qualquer PostgreSQL 16; sem DSN o gate sobe o Compose descartável.
pnpm test:postgres:coverage
pnpm test:postgres:runtime
DZ23_POSTGRES_DSN=... pnpm prove:storage-migration
DZ23_POSTGRES_DSN=... pnpm prove:backup-restore      # cópia → desastre → restauração → Studio religado
DZ23_POSTGRES_DSN=... pnpm prove:postgres-soak --minutes 30
pnpm build:edge
pnpm prove:edge
DZ23_CHROMIUM_PATH=/caminho/chromium pnpm prove:integration-hub   # Hub real + painel /studio/hub em Chromium
pnpm hub:sign keygen|pubkey|sign …                                 # publicador: chaves e manifesto assinado (ADR-031)
pnpm preflight:fase3
pnpm prove:fase3-agents
pnpm prove:generated-data
pnpm prove:form-database
pnpm prove:auth-crud
pnpm golden
```

No gate puro atual, os testes unitários passam e os 18 casos que exigem PostgreSQL real
ficam explicitamente pulados; a execução PostgreSQL do P31-A permanece
registrada na prova própria, sem ser apresentada como reexecução desta fatia.
Os geradores de dados, cadastro/lista, acesso, painel e o gate estrutural de imports
são medidos separadamente, e a cobertura global permanece acima de 90%. A
prova executável de acesso confirma 401 sem sessão, entra por código e executa
criar, editar e excluir. O golden set possui 12 casos executáveis e 6
`NOT_IMPLEMENTED`; LLM real continua `NOT_EXECUTED`. A prova de borda
usa Docker e exige que as
dependências do profile também tenham sido instaladas com
`pnpm --dir dsh-home/profiles/studio install --frozen-lockfile`. Isso não inclui
cerimônia de passkey com hardware, aparelho móvel físico ou deploy.

## Pesquisa com pessoas leigas

O kit controlado da fase 0.5 está em
[`docs/research/phase-0.5/README.md`](docs/research/phase-0.5/README.md). Ele
será adaptado depois do gate Windows para medir o DZ23 STUDIO completo antes do
piloto. Por E4, P32/P33/P31-B estão liberados para construção, mas a experiência
para leigos permanece `NOT_VALIDATED` até cinco sessões `VALID` e gate `GO`.
