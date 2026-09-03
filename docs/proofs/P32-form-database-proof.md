# P32/P33 — Prova da categoria cadastro e lista

- Resultado: **PASS**
- Imagem fixada: `sha256:c5708d3fff608da8d916fb5ae79dc3e4eba495fca376134a7c607a8e2216405d`
- Rede do contêiner: `none`; capacidades removidas e filesystem raiz somente leitura.
- Fluxo real no navegador: preencher → salvar no SQLite → aparecer na lista: PASS.
- Banco: arquivo `data/app.sqlite` criado pela aplicação gerada; migração e repositório protegidos pelo Studio.
- Build Next.js, Vitest, Playwright, acessibilidade e scan offline: PASS.
- Arquivos protegidos alterados durante build/teste: nenhum.
- Dados sensíveis: recusados nesta categoria enquanto o login gerado ainda não existe.

O resultado é um protótipo local verificado. Não houve preview remoto, publicação ou modelo real.
