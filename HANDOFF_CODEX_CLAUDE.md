# Handoff Codex → Claude — E4 e abertura de P32/P33/P31-B

## P32/P33 fatia 2 — correções do parecer `16ea5ec` prontas para revisão

Branch `codex/p32-fatia2-prompt-to-app`, commit corretivo
`635edb9f5665f907d49c2209fe67ae32335949a6`, sobre `16ea5ec`. Ainda sem
merge, push, PR ou deploy. Peço ao Claude revisar somente se a ALTA-1 e as
MÉDIAS 1–4 do parecer de 03/09/2026 foram fechadas, sem reabrir mérito.

Fechamentos implementados:

1. todo formulário gera acesso; envio não sensível continua público, mas toda
   lista/leitura exige sessão owner/member; `public_list=false` inclusive para
   entidades não sensíveis;
2. código de acesso ligado a `request_id` em cookie HttpOnly, tentativas
   isoladas por pedido, três emissões por e-mail em 15 minutos, intervalo de
   60 segundos e limpeza de códigos expirados; pedido suprimido não substitui
   o cookie de um pedido válido;
3. política AST recusa `process`, `globalThis`, `eval`, `Function`,
   `import.meta`, `'use server'`, `dangerouslySetInnerHTML` e JSX
   `script`/`iframe`/`object`; `'use client'` permanece permitido;
4. verificação canônica executa `next start` com `NODE_ENV=production` e
   captura só com `DZ23_STUDIO_VERIFICATION=1`; sem a flag, falha fechado em
   qualquer ambiente;
5. logotipo validado é copiado para `public/brand/logo.png`, entra na foto de
   integridade e é renderizado pelo layout com texto alternativo.

Gates no WSL2/ext4: typecheck e build recursivo PASS; 293 testes PASS, 18
integrações PostgreSQL explicitamente puladas; cobertura global 94,94% de
statements/91,45% branches e núcleo Prompt-to-App 90,41% statements; i18n PASS
com 199 chaves; escopos de domínio PASS. Provas `auth-crud`,
`form-database`, `generated-data`, `design-spec`, isolamento, template e fluxo
Prompt-to-App: PASS. A interface passou 2/2 Playwright + axe no contêiner com
`NetworkMode=none`, usuário 10001, raiz e mounts somente leitura,
`CapDrop=ALL` e `no-new-privileges`. Imagem fixada:
`sha256:c2011c57e0d8a2a66abb8626b53b2ef0abeedd7675ba4593924ee7bb99f2b33e`.

Golden set: 18 fixtures, 12 `PASS_DETERMINISTIC`, 6 `NOT_IMPLEMENTED` e 36
critérios declarados como `NOT_AUTOMATED`; promoção continua inelegível e LLM
real `NOT_EXECUTED`. P37 válido examinou 424 arquivos e 14 manifests, sem
achados. Uma tentativa anterior sobre diretório temporário ausente retornou
PASS com zero arquivos; foi rejeitada como inválida antes do gate final.
Varredura de segredos: somente o token falso do teste adversarial, nenhum
arquivo sensível rastreado. Upstream permanece limpo no pin
`6c705be1ce6774a000d061da41d1823b03a3d42c`.

Baixas não bloqueantes preservadas: catálogo separado para textos do app
gerado; retenção de logotipos/sessões/códigos; inventário redistribuível de
`sharp` 0.35.4 (Apache-2.0), binários libvips e demais dependências; prova SMTP
real; HTTPS do P34 para cookies `Secure`; custo de abrir/migrar SQLite por
ação. Preview/publicação seguem `NOT_PRESENT`; SaaS/dashboard/agendamento
`NOT_IMPLEMENTED`; passkey no app gerado `NOT_PRESENT`; experiência leiga
`NOT_VALIDATED`. O próximo build continua sendo P34, somente após este
fechamento e a decisão de integração.

## P32/P33 fatia 2 — blocos 1 a 3 prontos para revisão

Branch de trabalho: `codex/p32-fatia2-prompt-to-app`. Base:
`05d91f01eec191e727c1296b9190371678e17363`. Não houve merge, push, PR ou
deploy.

### Commits fechados

1. `36907ccb954ed93680fd4dd174ccc0ad7cb34a07` — autorização
   `project.write` antes de iniciar ou cancelar jobs, incluindo viewer → 403.
2. `5b16beb21cdd6815045e03a92557dedbe97279d3` — template
   `nextjs-app@1`, pipeline offline e fallback estático somente explícito.
3. DesignSpec, logotipo e correções do preparador estão no commit seguinte
   desta branch, informado no relatório do executor.

### Bloco DesignSpec

- domínio `studio_design_specs` versionado, com `org_id`, `tenant_id`, projeto,
  autor e SHA-256;
- quatro presets neutros próprios; seis papéis de cor, todos com par de texto
  validado em contraste WCAG AA 4,5:1;
- Geist Sans e Source Serif 4 locais por `next/font/local`, pesos fixos;
- `src/styles/tokens.css` determinístico, escrito pelo Studio e protegido do
  modelo;
- PNG/JPEG até 2 MB, assinatura e conteúdo conferidos, reencode PNG sem
  metadados, máximo 1.600 px, hash e armazenamento separado por tenant; SVG
  recusado;
- interface na etapa Ideia com cartões e opções avançadas; API e leitura
  adversarial não aceitam escopo do cliente.

### Achados fechados durante a prova

`setup-templates.mjs` deixava 104 MB/502 MB de `node_modules` dentro dos
templates-fonte. O fetch agora usa cópias temporárias somente dos manifests e
foi provado com `TEMPLATE_SOURCES_CLEAN=PASS`. O Next 16 reescreve
`next-env.d.ts` durante o build; esse é o único caminho excluído da comparação
pós-build, mas continua proibido para o modelo. Um teste negativo altera outro
arquivo protegido e recebe `TEMPLATE_INTEGRITY_FAILED`.

### Gates em WSL2/ext4

- typecheck e build recursivo: PASS;
- 246 testes: PASS; 18 integrações PostgreSQL puladas neste gate puro;
- cobertura: 94,13% statements e 90,96% branches; módulos críticos de
  identidade, policy, tenant e estado continuam em 100%;
- i18n: PASS, 182 chaves; domínios: PASS;
- P37 no artefato da árvore de commit: PASS, 401 arquivos, 14 manifests e zero
  achado; self-test negativo: PASS;
- interface web: 3 unitários e 2/2 E2E Playwright + axe: PASS;
- pipeline Next real: `VERIFIED_PROTOTYPE`, uma tentativa, LLM real
  `NOT_EXECUTED`;
- isolamento e template offline: PASS; `NetworkMode=none`, conexão bloqueada,
  não-root, `CapDrop=ALL`, `no-new-privileges`, raiz somente leitura e trust
  store do host idêntico;
- imagem fixada:
  `sha256:c5708d3fff608da8d916fb5ae79dc3e4eba495fca376134a7c607a8e2216405d`.

ADRs corrigidos conforme o prompt vinculante: ADR-021 é a autoridade de
segurança determinística, ADR-022 é o template Next.js e ADR-025 é o
DesignSpec. ADR-023 (dados) e ADR-024 (acesso) só serão fechados com os blocos
implementados.

### Ainda não implementado nesta branch

Blocos 4 a 8: gerador `node:sqlite`, categoria formulário+banco, autenticação
do app gerado, painel CRUD e golden set de 12 executáveis. Permanecem
`NOT_IMPLEMENTED`; preview/publicação continuam `NOT_PRESENT`; LLM real
`NOT_EXECUTED`; experiência leiga `NOT_VALIDATED`.

## P32/P33 fatia 2 — bloco 4: banco gerado (em revisão)

Branch: `codex/p32-fatia2-prompt-to-app`, sobre os commits isolados dos blocos
1 a 3. Nenhum merge, push, PR ou deploy.

O Studio agora aceita entidades de banco tipadas na AppSpec e gera, sem LLM,
`src/db/**`, `src/server/repositories/**` e um teste CRUD. O contrato cobre
texto, número, data, booleano, e-mail, telefone, seleção e referência; recusa
colisões de identificadores, referências ausentes e entidade sensível sem
confirmação. SQLite usa chaves estrangeiras, WAL e migrações idempotentes por
`user_version`.

Um gate de imports baseado no parser TypeScript recusa imports, reexports,
`require` e `import()` fora das facades permitidas com
`GENERATED_FILE_REJECTED`. A camada determinística é escrita antes da saída do
modelo, portanto entra em `protectedTemplatePaths` e no hash imutável.

Provas executadas em WSL2/ext4 e no construtor fixado:

- typecheck: PASS;
- 268 testes Studio PASS; 18 integrações PostgreSQL puladas no gate puro;
- cobertura global acima de 90%; gerador de banco e gate de imports em 100%;
- build Next, teste CRUD e E2E Playwright+axe dentro do contêiner sem rede:
  PASS; camada protegida permaneceu idêntica;
- autenticação, formulário, painel, preview, LLM real e publicação continuam
  fora desta prova.

Arquivos centrais: `plugins/prompt-to-app/src/data-generator.ts`,
`import-policy.ts`, ADR-023 e `docs/proofs/P32-generated-data-proof.md`.

## P32/P33 + P31-B fatia 1 — correções para segunda revisão Claude

Base do parecer: `b44ffe4`. Alvo da nova revisão: `b44ffe4..HEAD` na branch
`codex/p32-fatia1-prompt-to-app`. Não houve merge, push, PR ou deploy.

### Fechamento dos cinco achados médios

1. Servidor e frontend usam catálogos pt-BR versionados. O gate percorre
   `apps/studio-web/src` e todos os `plugins/*/src`; novos literais pt-BR fora
   de catálogo falham. A base preexistente de plugins antigos é congelada em
   `ab0fe506`, sem conceder exceção a código novo.
2. `POST /generate` registra `studio-prompt-to-app` em `ctx.jobs` e responde
   `202` com `run_id`. O trabalho só começa depois do registro; possui Agent
   interno como owner, etapa/tentativa persistidas, polling, cancelamento
   auditado e uma geração por projeto em cada processo. O cancelamento passa o
   mesmo owner a `ctx.jobs.kill`.
3. O Playwright sobe `createPromptToAppHttpHandler`, serviço, schemas, máquina
   de estados e job service reais. Somente LLM, builder e persistência são
   adapters determinísticos. Sessão, CSRF e membership passam pelos contratos
   reais.
4. O Studio compila a AppSpec em `tests/e2e/appspec.spec.ts` e registra
   `evidence/appspec-report.json`. Critérios objetivos precisam passar;
   subjetivos aparecem como `NOT_AUTOMATED`, nunca como aprovados.
5. O scanner valida dígitos de CPF. Telefones de 11 dígitos e CPF inválido não
   são bloqueados como CPF; CPF válido, formatado ou rotulado sem pontuação,
   falha fechado. Golden briefs cobrem as duas direções.

As seis baixas também foram tratadas: `mkdir` só após validação; ID local da
imagem documentado; substituição exige `--replace-existing`; UID/GID do host é
mapeado em Linux; `--approve-t2` e `sandbox: full` foram definidos com precisão;
o E2E móvel mostra o plano inteiro antes da aprovação.

### Gates executados em WSL2/ext4

- typecheck e build: PASS;
- testes unitários: 236 PASS e 18 integrações PostgreSQL puladas no gate puro;
- cobertura: 93,62% statements, 90,75% branches e controles de segurança
  sensíveis em 100%;
- PostgreSQL real: PASS, inclusive runtime com 19 domínios;
- `gate:i18n`: PASS, 150 chaves; `gate:domain-scopes`: PASS;
- Playwright contra handler real: 2/2 em contêiner fixado, sem rede, sem
  capacidades, não-root e com raiz somente leitura;
- pipeline, builder e template: PASS; critérios AppSpec e duas evidências com
  SHA-256 foram gravados;
- runtime/reinício, agentes/rotas e borda: GO;
- gate P37 no `git archive`: PASS, 369 arquivos, 13 manifestos e zero achado;
  o self-test negativo detectou MITM, `freestyle` e `caveman-shrink`;
- setup sem `--approve-t2` e substituição sem `--replace-existing`: recusados
  deliberadamente;
- upstream permanece limpo no pin
  `6c705be1ce6774a000d061da41d1823b03a3d42c`.

Classificação naquele fechamento: landing/catalog = **BETA**; formulário+banco,
painel CRUD, SaaS autenticado e dashboard = `NOT_IMPLEMENTED`;
preview/publicação = `NOT_PRESENT`; LLM real e celular físico = `NOT_EXECUTED`;
experiência leiga = `NOT_VALIDATED`. O repositório continua
não redistribuível até a escolha e aplicação da licença open source.

Base anterior à E4: `codex/p30-policy-foundation@c8d73f5`. A Fase 3 está fechada e integrada
localmente. Sem push, PR ou deploy.

## Decisão vinculante do Prado

E4 revoga a fase 0.5 como pré-requisito de construção. P32, P33 e P31-B podem
começar agora. A fase 0.5 passa a testar o DZ23 STUDIO completo depois do gate
Windows da fase 9 e antes do piloto da fase 10.

Até cinco sessões `VALID` produzirem `GO` no gate 4/5:

- experiência para pessoas leigas = `NOT_VALIDATED`;
- piloto e release público permanecem bloqueados;
- documentação e interface não podem chamar preview, staging, teste focado ou
  mock de “aplicação pronta”.

## Regras para a construção liberada

1. Fluxo inicial de referência: **Ideia → Perguntas → Plano → Criação →
   Verificação**, vindo do OmniSeek P40 sem incorporar seu código.
2. Textos, ordem das etapas e glossário em arquivos de linguagem separados e
   versionados, pt-BR primeiro.
3. Estados operacionais verdadeiros. Nenhum deploy além de `PREVIEW_OK` e
   `STAGING_OK` nas fases autorizadas.
4. P31-B cria domínios tenant-aware para projeto, execução, aprovação e
   evidência sobre o storage já construído; o log de sessão do Harness não é
   substituído.
5. Revisão Claude de cada fatia de interface inclui linguagem comum.
6. Pesquisa sem gravação por padrão; gravação consentida é apagada em 30 dias,
   preservando somente resultados anônimos.

## Próximo prompt pedido ao Claude

Fornecer o prompt consolidado da primeira fatia vertical de P32/P33/P31-B. Ele
deve preservar E4, D02 (zero diff upstream), D14 (tenant-aware), D21 (golden
set), D30 (cobertura), tiers T0–T3 e nenhum deploy de produção.

## Histórico verificado da Fase 3

1. Confirmar que `@dz23-studio/agents` é a única porta de Codex/Claude e que a
   concessão de policy exige ancestral coordenador + mesmo `cwd` de worktree.
2. Confirmar duas aprovações: início e aplicação da proposta.
3. Confirmar as quatro correções pedidas no parecer sobre `f134e4c`:
   - mudança do projeto principal preserva `PROPOSED`, marca
     `main_changed_during_run` e não percorre árvores não rastreadas;
   - aplicação compara `base_commit..HEAD` e bloqueia arquivo também alterado
     por commit posterior;
   - T3 consulta identidade forte no serviço de identidade e o run grava
     `approved_by`/`approved_at`;
   - `privacy: local-only` nunca escolhe rota externa e audita a recusa.
4. Conferir budgets, leases, tamper SHA-256 e conflito entre duas propostas.
5. Conferir fallback OmniRoute somente antes de conteúdo/tool, retry zero e
   que ele só se aplica a uma seleção `any` já autorizada.
6. Conferir que testes reais estão `NOT_EXECUTED`, não simulados como prontos.
7. Conferir a limitação declarada de SIGKILL no provider in-process e a prova
   parcial, não absoluta, do commit do Hermes.

Gates esperados no fechamento: 216/216 com PostgreSQL real e 100% nas quatro
métricas; PoC 3A, runtime, edge, Postgres runtime, domínios e P37 em PASS/GO.

Arquivos principais: `plugins/agents`, `plugins/route-health`,
`dsh-home/profiles/studio/cordis.patch.yml`, ADR-014, ADR-015 e prova P35.

## P32/P33 fatia 2 — bloco 5 cadastro e lista

Branch de trabalho: `codex/p32-fatia2-prompt-to-app`. Base dos blocos 1–4:
`c13ce6e`. Este bloco ainda não foi mesclado, enviado ou implantado.

- A taxonomia foi alinhada à D21: `form-database`, `crud-panel`,
  `saas-authenticated`, `landing-page`, `catalog` e `dashboard`. A interface
  mostra “cadastrar informações e vê-las em uma lista”, não o identificador.
- `FormCategoryCapabilityError` recusa falta de entidade, dados sensíveis,
  referência obrigatória sem painel e plano sem `src/GeneratedApp.tsx` antes
  de a saída do modelo ser aplicada.
- O Studio gera Server Actions e componentes de formulário/lista protegidos;
  o modelo pode importá-los, mas não altera banco, migrações, repositórios ou
  ações.
- O compilador de aceitação gera Playwright para preencher, salvar e exigir o
  valor na lista. A prova `pnpm prove:form-database` passou com SQLite em
  arquivo, 9 caminhos protegidos, 12 checks e 4 etapas offline na imagem
  `sha256:c5708d3fff608da8d916fb5ae79dc3e4eba495fca376134a7c607a8e2216405d`.
- Golden set: 18 totais, 8 `PASS_DETERMINISTIC`, 10 `NOT_IMPLEMENTED`, LLM
  real `NOT_EXECUTED`. `form-database-02` continua bloqueado até a autenticação
  gerada.
- Gates da árvore antes do commit: typecheck PASS; 273 testes PASS e 18 casos
  PostgreSQL pulados no gate puro; cobertura global 94,70% statements e 90,83%
  branches; `form-generator.ts` e `planner.ts` em 100% nas quatro métricas;
  i18n PASS com 195 chaves; domínios PASS; build dos 10 pacotes PASS; P37 no
  `git archive` PASS com 414 arquivos, 14 manifestos e zero achado, e self-test
  negativo PASS para MITM, `freestyle` e `caveman-shrink`.
- Não há preview, publicação, deploy, segredo ou alteração no upstream.

Arquivos centrais para revisão: `src/form-generator.ts`, `src/planner.ts`,
`src/acceptance.ts`, `src/pipeline.ts`, `scripts/prove-form-database.ts`,
`scripts/run-golden-set.ts`, ADR-026 e a capability matrix. Confirmar em
especial que nenhum dado sensível chega ao modelo nessa categoria e que os
componentes determinísticos entram na foto imutável antes da geração.

## P32/P33 fatia 2 — fechamento dos blocos 6 e 7

Branch de revisão: `codex/p32-fatia2-prompt-to-app`. Base integrada local:
`codex/p30-policy-foundation@05d91f0`. Esta branch deve permanecer isolada:
**não fazer merge, push, PR ou deploy** antes do parecer do Claude.

### O que foi construído

- Camada determinística de acesso sem senha nos aplicativos gerados: primeiro
  proprietário limitado a `APP_OWNER_EMAIL`, convite de membros, código de seis
  dígitos com TTL de dez minutos e cinco tentativas, sessão opaca revogável,
  cookie `HttpOnly`/`Secure`/`SameSite=Lax` e double-submit CSRF.
- Códigos ficam somente como derivação `scrypt` com sal no SQLite; tokens de
  sessão ficam somente como SHA-256. `studio-capture` é restrito a
  desenvolvimento, usa arquivo `0600` e falha fechado em produção. SMTP só
  aceita configuração por referências de ambiente; SMTP sem TLS é recusado.
- Migrações de autenticação usam `auth_schema_migrations` e não avançam o
  `PRAGMA user_version` da camada de dados.
- Categoria `crud-panel` gera, sem LLM, ações autenticadas de criar, editar e
  excluir, painel e confirmação de exclusão. Formulários sensíveis também
  exigem login. Referências entre entidades continuam recusadas até existir um
  seletor seguro.
- Aceitação executável percorre login e CRUD real no navegador. O pipeline
  protege banco, migrações, autenticação, formulário e painel contra alteração
  pelo modelo.
- O backend só expõe códigos capturados ao projeto e tenant autorizados depois
  de `VERIFIED_PROTOTYPE` com run `PASSED`; a interface mostra isso apenas na
  etapa Verificação e avisa que os códigos da prova já foram consumidos.
- Template Next.js ganhou headers CSP, `nosniff`, `DENY`, referrer policy e
  permissions policy. Diretório de dados é `0700` e SQLite é `0600` no Linux.

### Evidência executada no conteúdo final

- `typecheck`, build dos dez pacotes, `gate:i18n` com 199 chaves e
  `gate:domain-scopes`: PASS.
- Vitest: **281 PASS**, 18 integrações PostgreSQL puladas no gate sem serviço;
  cobertura global 94,95% statements, 91,46% branches, 95,65% functions e
  97,29% lines. Geradores de auth, CRUD, dados e formulário: 100%.
- UI Playwright na imagem fixada e sem rede: **2/2 PASS** (recusa sem sessão e
  jornada das cinco etapas sem alegar publicação).
- `AUTH_CRUD_PROOF=PASS`: 18 caminhos protegidos, 12 checks, quatro etapas;
  login, sessão e CRUD real passaram em contêiner `NetworkMode=none`, sem
  capacidades, não-root e com raiz somente leitura.
- `GENERATED_DATA_PROOF`, `FORM_DATABASE_PROOF`,
  `BUILDER_ISOLATION_PROOF`, `TEMPLATE_PIPELINE_PROOF` e
  `PROMPT_TO_APP_PROOF`: PASS.
- Golden set: **12 `PASS_DETERMINISTIC`**, seis `NOT_IMPLEMENTED`; LLM real
  `NOT_EXECUTED` e promoção pública proibida.
- Gate P37 no `git archive`: PASS, 423 arquivos, 14 manifestos, zero achado;
  o self-test negativo detectou caminho MITM, dependência `freestyle`, licença
  ausente e assinatura `caveman-shrink`.
- Imagem canônica das provas:
  `sha256:c2011c57e0d8a2a66abb8626b53b2ef0abeedd7675ba4593924ee7bb99f2b33e`.

### Limites verdadeiros

Não houve LLM real, SMTP real, passkey, preview, publicação, deploy, celular
físico nem teste com pessoas leigas. Dashboard e SaaS autenticado permanecem
`NOT_IMPLEMENTED`; experiência leiga permanece `NOT_VALIDATED`. O Playwright
direto no WSL não iniciou por bibliotecas nativas ausentes; a prova canônica
passou na imagem fixada do builder. PostgreSQL real não foi reexecutado nesta
fatia e suas 18 integrações ficaram explicitamente puladas no gate puro.

### Pontos prioritários da revisão Claude

1. Autoridade de owner/member, convite e impossibilidade de autoelevação.
2. Armazenamento de código/sessão, TTL, tentativas, cookies e CSRF.
3. Separação entre migrações de autenticação e de dados.
4. `studio-capture` recusado em produção e ausência de segredo literal.
5. Isolamento por organização/tenant na exposição dos códigos de verificação.
6. Pipeline impedindo que o modelo sobrescreva arquivos determinísticos.
7. Fluxo CRUD real e proteção de formulário sensível.
8. Estados e textos sem chamar protótipo verificado de aplicação pronta.
