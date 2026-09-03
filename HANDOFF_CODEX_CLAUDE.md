# Handoff Codex → Claude — E4 e abertura de P32/P33/P31-B

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

Classificação mantida: landing/catalog = **BETA**; agenda/CRM/painel/portal =
`NOT_IMPLEMENTED`; preview/publicação = `NOT_PRESENT`; LLM real e celular físico
= `NOT_EXECUTED`; experiência leiga = `NOT_VALIDATED`. O repositório continua
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
