# M6.7 — Seguimento da auditoria de clone limpo

Estado: **GO WITH KNOWN LOAD-SENSITIVE TESTS / PHYSICAL POSTGRES TEST PENDING**
Data: 2026-09-06

## Relatório recebido

A auditoria independente foi feita sobre a árvore antiga `72bea57`. Na base
atual, `a5815cd`, já estavam presentes as três correções estruturais principais:

- `injectWorkspacePackages: false` no workspace de desenvolvimento;
- `dependenciesMeta.injected` restrito ao pacote de runtime que precisa ser
  materializado para deploy;
- aliases canônicos de `runtime-governor` e `preview-supervisor` no Vitest.

Esses itens foram confirmados por leitura da árvore atual e por uma instalação
nova em ext4, descrita abaixo.

## Regressão de teste corrigida

O guard de restauração exige `--allow-record-loss` quando o alvo contém
registros. Três jornadas de integração anteriores ao guard ainda esperavam que
uma substituição destrutiva passasse somente com `--force` e a confirmação.
Elas agora declaram também `--allow-record-loss`:

- limpeza segura de schemas de staging;
- segredo e política TLS ausentes do `argv` de `pg_dump`;
- substituição com backup e recusa enquanto o Studio está ativo.

O teste unitário do guard continua provando que a ausência da nova confirmação
falha fechada (**8/8 PASS**) e o typecheck agregado passou depois da alteração.
As três jornadas alteradas exigem PostgreSQL real e continuam `NOT_EXECUTED`
localmente porque não há DSN e o Docker permanece desligado.

## Resíduo que não foi apagado

Há 95 arquivos rastreados sob `plugins/*/lib/**` apesar da regra no
`.gitignore`. Removê-los do índice altera o formato do checkout e não foi
autorizado pelo operador; portanto, nenhum `git rm --cached` foi executado.
Até essa decisão e uma prova nova em clone limpo, o projeto não deve afirmar
checkout higienicamente reproduzível antes do build. A prova abaixo demonstra
o bootstrap funcional quando a ordem canônica inclui o build.

## Clone limpo executado em WSL2 ext4

A prova partiu exclusivamente do bundle
`M67_CLEAN_CLONE_FOLLOWUP_b844a8d.bundle`, SHA-256
`0DDACD8B0FB8CB0A181B2589B574498555625DE6F99F564569EEDC856E5E5DFF`,
clonado em `/home/leandro/dz23-gates/m67-clean-clone-20260906-0658`.
O submodule foi materializado no commit
`6c705be1ce6774a000d061da41d1823b03a3d42c` e a verificação independente do
conteúdo retornou:

```text
UPSTREAM_CONTENT=PASS entries=8953 sha256=862b92782c2f5cd67f81debd1116b16150dfafd84fb4ce2602a729f9cf3d26dc
```

Como a prova inicializou o submodule a partir de uma cópia Git local em vez da
URL pública da `.gitmodules`, a configuração local trouxe `core.worktree` no
arquivo comum. O `postinstall` do Harness recusou corretamente essa topologia.
Na cópia descartável, a configuração foi normalizada para o formato oficial de
worktree (`extensions.worktreeConfig=true`, formato de repositório 1 e
`core.worktree` no `config.worktree`). Nenhum arquivo-fonte foi alterado. Esse
ajuste é específico da fonte local usada pela prova e não foi observado como
requisito de um clone da URL pública.

Depois da normalização, passaram:

- instalação congelada e `build:official` do Harness;
- instalação congelada e filtrada do Studio;
- `pnpm build` do cliente e dos plugins;
- `pnpm typecheck` da raiz.

O build novo reescreveu 42 dos 95 arquivos `plugins/*/lib/**` rastreados. Isso
confirma objetivamente que os artefatos versionados estão defasados. A prova
continuou usando a saída recém-compilada; ela não autoriza remover os arquivos
do índice da árvore de trabalho.

## Estabilidade da suíte no clone limpo

Foram feitas três execuções completas ou focadas, sem PostgreSQL físico:

1. paralelismo padrão: **1.900 PASS, 62 SKIP, 2 FAIL**;
2. quatro workers: **1.901 PASS, 62 SKIP, 1 FAIL**;
3. dois workers: **1.902 PASS, 62 SKIP, 0 FAIL** em 57,42 s.

As três falhas distintas ocorreram somente sob carga da suíte:

- `store-provision.spec.ts` — liberação de descritores/event loop;
- `unix-server.spec.ts` — preservação de socket estrangeiro durante `close`;
- `manager-state.spec.ts` — exclusividade multiprocesso e liberação após
  `SIGKILL`.

Cada teste passou isoladamente; o terceiro, por exemplo, passou em 613 ms. Os
dois primeiros também passaram na execução seguinte e todos passaram juntos
com dois workers. Portanto, não há defeito lógico estável reproduzido, mas o
gate padrão é sensível à pressão de CPU/I/O. Até os testes de multiprocesso e
filesystem ganharem sincronização determinística, o gate canônico de clone
limpo usa `pnpm test -- --maxWorkers=2` e registra qualquer divergência, sem
repetir silenciosamente até ficar verde.

## Limites honestos

- Os três testes PostgreSQL corrigidos exigem um PostgreSQL 16 real e continuam
  `NOT_EXECUTED` nesta máquina, pois o Docker permanece desligado e não há DSN.
- A remoção dos 95 `plugins/*/lib/**` rastreados continua aguardando autorização
  do proprietário. Até isso ocorrer, o bootstrap é funcional depois de
  `pnpm build`, mas o checkout não é higienicamente reproduzível antes do build.
