# M5 — Prova de exportação real do Integration Hub

- Resultado: **BLOCKED_EXTERNAL**
- Motivo: `BUILDER_INPUTS_NOT_CONFIGURED` (builder digest: ausente; template store: ausente).
- Standalone real produzido pelo pipeline: `NOT_EXECUTED`.
- Exportação: `NOT_EXECUTED`.
- Aplicação pronta: **não afirmada**.
- A prova não fabrica `server.js`, não promove o projeto por `transition()` e não grava uma run `PASSED` manualmente.
- O teste de integração `pipeline-export.integration.spec.ts` prova que uma execução `BLOCKED_EXTERNAL` criada pelo pipeline real continua não exportável, inclusive sob tentativa de outro tenant. Esse teste é somente o contrato entre os módulos; não substitui Docker, build Next.js, Playwright ou a exportação física.

Para obter `GO`, preparar `runtime/builder-image-digest` e `runtime/template-store-v2`, manter a imagem fixada disponível no Docker e executar `pnpm prove:integration-hub`. Somente o caminho positivo do script aceita a run `PASSED` escrita pelo pipeline após build e testes isolados com `--network none`.
