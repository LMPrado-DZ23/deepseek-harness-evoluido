# P32/P33 — Prova de acesso e painel CRUD

- Resultado: **PASS**
- Imagem fixada: `sha256:c2011c57e0d8a2a66abb8626b53b2ef0abeedd7675ba4593924ee7bb99f2b33e`
- `docker inspect`: `HostConfig.NetworkMode=none`.
- Tentativa de conexão externa dentro do contêiner: bloqueada.
- Login: código de 6 dígitos capturado pelo canal local de desenvolvimento; sessão real em SQLite.
- Rota `/api/auth/session`: 401 sem sessão e 200 após autenticação.
- Fluxo real no navegador: login → listar → criar → editar → excluir com confirmação: PASS.
- Vitest cobre sessão válida, expirada e revogada, CSRF ausente, cinco tentativas e recusa de captura em produção.
- Build Next.js, testes, Playwright, acessibilidade e scan: PASS em contêiner sem rede.
- SQLite restrito a modo `0600` no Linux.
- Arquivos de banco, autenticação e CRUD alterados durante build/teste: nenhum.

O modo `studio-capture` é somente para verificar o protótipo e é recusado em produção. Não houve preview remoto, publicação ou modelo real.
