# P32/P33 — Prova da camada de dados gerada

- Resultado: **PASS**
- Imagem fixada: `sha256:c5708d3fff608da8d916fb5ae79dc3e4eba495fca376134a7c607a8e2216405d`
- Rede do contêiner: `none`; capacidades removidas e filesystem raiz somente leitura.
- Banco: `node:sqlite`, sem ORM e sem módulo nativo adicional.
- Migração idempotente, `foreign_keys=ON`, WAL e `user_version=1`: PASS.
- CRUD real em memória dentro do contêiner (criar, listar, atualizar e excluir): PASS.
- Build Next.js, Vitest e Playwright+axe offline: PASS.
- Arquivos protegidos alterados durante build/teste: nenhum.

O resultado continua sendo um protótipo verificado localmente; autenticação, preview e publicação ainda não fazem parte desta prova.
