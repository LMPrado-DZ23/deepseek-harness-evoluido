# P32 — Prova executável do template v1

- Resultado: **PASS**
- Imagem fixada: `sha256:c5708d3fff608da8d916fb5ae79dc3e4eba495fca376134a7c607a8e2216405d`
- Instalação: offline, lockfile congelado e scripts de pacote desativados.
- Fontes: Geist Sans e Source Serif 4 locais via next/font/local; nenhum download no build.
- Build: PASS
- Teste unitário: PASS
- E2E Playwright + axe: PASS
- Execuções: `pnpm install --offline --frozen-store --frozen-lockfile --trust-lockfile --store-dir /template-store --ignore-scripts` → exit 0; `pnpm run build` → exit 0; `pnpm run test` → exit 0; `pnpm run test:e2e` → exit 0.
- Arquivos iniciais alterados pelo framework: `next-env.d.ts`; nenhuma alteração inesperada.
- Isolamento: todos os comandos foram emitidos pelo `ContainerBuilder` com rede desativada e limites de recursos.

O artefato é somente um protótipo verificado dentro do contêiner; não houve preview público nem deploy.
