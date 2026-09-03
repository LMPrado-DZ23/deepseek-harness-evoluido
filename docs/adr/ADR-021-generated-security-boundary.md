# ADR-021 — Segurança determinística do aplicativo gerado

Status: aceita; implementação incremental na fatia 2.

Autenticação, autorização, sessão, CSRF, esquema de dados, migrações,
repositórios, validações e cabeçalhos do aplicativo gerado pertencem ao
gerador determinístico do DZ23 STUDIO. O modelo de linguagem nunca pode criar
nem alterar esses componentes.

O modelo fica limitado a páginas, textos, layout e aos consumidores públicos
explicitamente permitidos dos repositórios gerados. A lista de arquivos do
plano não concede acesso aos caminhos protegidos. A validação estrutural de
imports e a comparação de integridade do template são gates independentes.

Os módulos determinísticos entram em `src/server/**`, `src/db/**`,
`src/auth/**`, `middleware.ts`, migrações e `src/styles/tokens.css`. Eles são
gravados antes da saída do modelo e incluídos em `protectedTemplatePaths`.
Uma tentativa do modelo de escrever ou importar fora do contrato termina como
`GENERATED_FILE_REJECTED`; não existe fallback permissivo.

Este ADR define a autoridade. ADR-023 e ADR-024 documentam, respectivamente,
os contratos concretos de dados e acesso quando esses blocos forem fechados.
