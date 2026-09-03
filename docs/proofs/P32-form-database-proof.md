# P32/P33 — Prova da categoria cadastro e lista

- Resultado: **PASS**
- Imagem fixada: `sha256:c2011c57e0d8a2a66abb8626b53b2ef0abeedd7675ba4593924ee7bb99f2b33e`
- Rede do contêiner: `none`; capacidades removidas e filesystem raiz somente leitura.
- Fluxo real no navegador: preencher anonimamente → lista ausente para visitante → entrar como proprietário → registro aparece na lista: PASS.
- Banco: arquivo `data/app.sqlite` criado pela aplicação gerada, restrito a modo `0600` no Linux; migração e repositório protegidos pelo Studio.
- Build Next.js, Vitest, Playwright, acessibilidade e scan offline: PASS.
- Arquivos protegidos alterados durante build/teste: nenhum.
- Dados sensíveis confirmados exigem autenticação também no envio; esta prova usa dados comuns com envio público e leitura privada.

O resultado é um protótipo local verificado. Não houve preview remoto, publicação ou modelo real.
