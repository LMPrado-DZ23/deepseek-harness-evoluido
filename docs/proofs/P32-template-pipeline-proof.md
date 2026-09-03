# P32 — Prova executável do template v1

- Resultado: **PASS**
- Imagem fixada: `sha256:0019ae56c58bb6a3f4d26c3330a5bb15402908f8a4cb14f2e866d8e301839a63`
- Instalação: offline, lockfile congelado e scripts de pacote desativados.
- Build: PASS
- Teste unitário: PASS
- E2E Playwright + axe: PASS
- Execuções: `pnpm install --offline --frozen-store --frozen-lockfile --trust-lockfile --store-dir /template-store --ignore-scripts` → exit 0; `pnpm run build` → exit 0; `pnpm run test` → exit 0; `pnpm run test:e2e` → exit 0.
- Isolamento: todos os comandos foram emitidos pelo `ContainerBuilder` com rede desativada e limites de recursos.

O artefato é somente um protótipo verificado dentro do contêiner; não houve preview público nem deploy.
