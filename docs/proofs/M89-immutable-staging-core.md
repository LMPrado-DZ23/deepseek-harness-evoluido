# M89 — prova do núcleo de staging imutável

Data: 07/09/2026. Estado: **STAGING_CORE_BETA / CHECKPOINTING** na branch
`codex/m89-immutable-staging`, baseada em
`2f2a772d98d916514652e0f7797f00339c9a3877`. Harness preservado em
`6c705be1ce6774a000d061da41d1823b03a3d42c`.

Esta prova não autoriza merge, push, PR, deploy, Docker ou publicação. Provider
real, rota HTTP, runtime e produção não foram criados nem executados.

## Contrato implementado

- journal tenant-aware criado antes do claim T2;
- resposta perdida do claim T2 permanece `APPROVAL_PENDING` e retoma com a
  mesma identidade; somente negação explícita vira `APPROVAL_REJECTED`;
- fingerprint canônico, replay idempotente e conflito para operação divergente;
- exclusão global e vínculo de escopo pelo destino físico;
- geração monotônica, CAS, fencing e lease retomável somente antes do efeito;
- efeito incerto preservado em `RECONCILIATION_REQUIRED`;
- receipt completo validado contra artefato, provider, destino, operação, tipo
  e geração;
- finalização + ponteiro ativo e rollback + comparação da geração declarados
  como transações obrigatórias do adapter;
- quarentena de efeito externo aceito que diverge do journal, com fencing que
  preserva e bloqueia uma geração mais nova já em voo;
- timestamps comparados como instantes e ordem causal validada;
- ambiente restrito por schema ao literal `staging`.

## Provas executadas nesta árvore

- `pnpm --filter @dz23-studio/staging test`: **30/30 PASS**;
- cobertura focada: statements **91,36%**, branches **91,14%**, functions
  **97,05%**, lines **95,85%**; `artifact.ts` e `security.ts` em **100%**;
- `pnpm typecheck`: **PASS**;
- build canônico do Harness com `CI=true`: **PASS**;
- `pnpm build`: **PASS**, 19 projetos selecionados; o script raiz foi
  corrigido porque o filtro de caminho anterior encerrava com sucesso e zero
  plugins no Windows;
- contrato do comando de build: **2/2 PASS**;
- i18n: **PASS**, 13 catálogos e 290 chaves;
- escopo de domínio: **PASS**;
- rotas Postgres: **25/25** em dois patches;
- catálogo do assistente e portabilidade: **PASS**;
- P37 self-test positivo/negativo/vazio: **PASS**; artefato candidato preservado
  em `outputs/M89_P37_CANDIDATE_20260907_0645`: **890 arquivos, 23 manifests,
  uma licença e zero achado**;
- pin do upstream: self-test **PASS**; inspeção física **BLOCKED_ENVIRONMENT**
  porque o Windows sem permissão de symlink materializou
  `.agents/notes/implemented/CLAUDE.md` como arquivo-texto. O upstream não foi
  alterado para mascarar a limitação.

## Suíte geral no Windows nativo

`pnpm exec vitest run --maxWorkers=1` terminou com **1.740 aprovados, 358
pulados e 29 falhas**, em 104 arquivos aprovados, 21 pulados e dez com falha.
Nenhuma falha pertence a `plugins/staging`.

As falhas são da baseline de ambiente Windows: testes que criam symlink ou
FIFO sem privilégio/tool POSIX, socket Unix, modos e blocos esparsos do
filesystem, sinal `SIGKILL`, e uma suíte TLS sem `openssl` no `PATH`. O clone
limpo anterior em WSL2/ext4 (M87) terminou com 2.036 testes aprovados, 62
pulados e zero falha, antes do M89. Esta evidência não substitui uma repetição
do M89 naquele ambiente e não chama a suíte Windows de verde.

## Revisão adversarial

A primeira passagem independente encontrou uma corrida de quarentena contra
geração nova, ambiguidade na resposta do claim T2 e um estado iniciado sem
aprovação aceito pelo schema. As três reproduções viraram correções e testes.
A re-revisão exclusivamente estática confirmou **GO para
`STAGING_CORE_BETA`**, sem caminho restante de efeito sem T2 ou roubo do lock.

## Limite honesto

O pacote prova a lógica e as portas do núcleo. Não prova durabilidade física,
provider, deploy, preview, staging funcional ou experiência humana. Antes de
qualquer montagem, faltam adapter Postgres real, fonte durável do artefato,
autoridade T2 e prova externa de reconciliação.
