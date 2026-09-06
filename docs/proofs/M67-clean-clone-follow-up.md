# M6.7 — Seguimento da auditoria de clone limpo

Estado: **PARTIAL / PHYSICAL POSTGRES TEST PENDING**  
Data: 2026-09-06

## Relatório recebido

A auditoria independente foi feita sobre a árvore antiga `72bea57`. Na base
atual, `a5815cd`, já estavam presentes as três correções estruturais principais:

- `injectWorkspacePackages: false` no workspace de desenvolvimento;
- `dependenciesMeta.injected` restrito ao pacote de runtime que precisa ser
  materializado para deploy;
- aliases canônicos de `runtime-governor` e `preview-supervisor` no Vitest.

Esses itens foram confirmados por leitura da árvore atual. Isso não equivale a
uma nova instalação limpa, que permanece `NOT_EXECUTED` neste checkpoint.

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
bootstrap reproduzível a partir de checkout virgem.
