# P31-B — Prova de migração da instância de desenvolvimento (json → PostgreSQL)

- Resultado: **GO**
- Origem: Studio real no backend `json` padrão do Harness, povoado pelos serviços reais: cadastro por código de e-mail, bootstrap de organização/espaço, um projeto Prompt-to-App da fatia 2 (`form-database`) com perguntas, AppSpec, DesignSpec, plano proposto e aprovado (aprovação T1), run `PASSED` e evidência.
- Exportação: `pnpm storage:export-json` com o Harness parado; 20 domínios e 28 registros; bundle validado (formato, pin do Harness, SHA-256 por domínio e do payload).
- Importação: `pnpm storage:import-postgres --write` (esquema de staging + troca atômica); o snapshot lido do PostgreSQL bate hash a hash com a exportação.
- Nova execução: o Studio subiu sobre PostgreSQL com a cópia json apagada; a sessão emitida antes da migração continuou válida; projeto, perguntas, spec, design, plano, run e evidência leram idênticos (JSON canônico); uma escrita nova (arquivar o projeto) ficou no PostgreSQL.
- Unidades no esquema: 20. Nenhum dado real de pessoa foi usado (e-mail fictício `example.test`).

Limite: migra os domínios do Studio; sessões e logs do próprio Harness usam outro caminho e não fazem parte do bundle (D-P31-A).
