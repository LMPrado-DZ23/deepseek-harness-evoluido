# P32 — Prova executável do template v1

- Resultado: **PASS**
- Imagem fixada: `sha256:c2011c57e0d8a2a66abb8626b53b2ef0abeedd7675ba4593924ee7bb99f2b33e`
- Instalação: offline, lockfile congelado e scripts de pacote desativados.
- Fontes: Geist Sans e Source Serif 4 locais via next/font/local; nenhum download no build.
- Build: PASS
- Teste unitário: PASS
- E2E Playwright + axe: PASS
- Cabeçalhos CSP, nosniff, frame deny e referrer policy: PASS no navegador.
- Execuções: `pnpm install --offline --frozen-store --frozen-lockfile --trust-lockfile --store-dir /template-store --ignore-scripts` → exit 0; `pnpm run build` → exit 0; `pnpm run test` → exit 0; `pnpm run test:e2e` → exit 0.
- Arquivos iniciais alterados pelo framework: `next-env.d.ts`; nenhuma alteração inesperada.
- Isolamento: todos os comandos foram emitidos pelo `ContainerBuilder` com rede desativada e limites de recursos.

O artefato é somente um protótipo verificado dentro do contêiner; não houve preview público nem deploy.
