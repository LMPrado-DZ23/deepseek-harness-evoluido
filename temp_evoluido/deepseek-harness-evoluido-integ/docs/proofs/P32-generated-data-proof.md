# P32/P33 — Prova da camada de dados gerada

- Resultado: **PASS**
- Imagem fixada: `sha256:c2011c57e0d8a2a66abb8626b53b2ef0abeedd7675ba4593924ee7bb99f2b33e`
- Rede do contêiner: `none`; capacidades removidas e filesystem raiz somente leitura.
- Banco: `node:sqlite`, sem ORM e sem módulo nativo adicional.
- Migração idempotente, `foreign_keys=ON`, WAL e `user_version=1`: PASS.
- CRUD real em memória dentro do contêiner (criar, listar, atualizar e excluir): PASS.
- Build Next.js, Vitest e Playwright+axe offline: PASS.
- Arquivos protegidos alterados durante build/teste: nenhum.

O resultado continua sendo um protótipo verificado localmente; autenticação, preview e publicação ainda não fazem parte desta prova.
