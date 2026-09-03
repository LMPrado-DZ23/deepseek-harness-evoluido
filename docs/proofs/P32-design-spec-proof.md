# P32 — Prova do DesignSpec v1

Data: 03/09/2026.

## Resultado

**PASS** para o bloco DesignSpec, ainda classificado como BETA.

- Domínio físico `studio_design_specs` classificado como `org-tenant`; gate de
  escopo: PASS.
- API autenticada para salvar aparência e logotipo, sem aceitar organização ou
  tenant do corpo; casos adversariais entre tenants: PASS.
- Presets neutros moderno, profissional, colorido e minha marca: PASS.
- Seis papéis de cor com pares validados em contraste WCAG AA 4,5:1: PASS.
- Tokens determinísticos em `src/styles/tokens.css`, incluídos nos caminhos
  protegidos: PASS.
- Geist Sans e Source Serif 4 carregadas localmente, sem Google Fonts: PASS.
- PNG/JPEG de até 2 MB reencodado como PNG, sem metadados, com limite de
  dimensão, hash e separação por organização/tenant; SVG e conteúdo inválido:
  recusados.
- Template Next.js: instalação offline, build standalone, Vitest e Playwright
  com axe em contêiner sem rede: PASS.
- O próprio Next reescreve apenas `next-env.d.ts`; esse caminho continua
  proibido para o modelo e é a única exceção na comparação pós-build. Alterar
  outro arquivo protegido: teste negativo PASS.
- Jornada web real da etapa Ideia até `VERIFIED_PROTOTYPE`: 2/2 E2E PASS no
  contêiner fixado.
- Suíte do Studio: 246 PASS, 18 integrações PostgreSQL puladas no gate puro;
  cobertura 94,13% statements e 90,96% branches.
- P37 sobre a árvore exata preparada para commit: PASS, 401 arquivos,
  14 manifests e zero achado; self-test negativo detectou caminho MITM,
  `freestyle` e `caveman-shrink`.
- Imagem do construtor nesta prova:
  `sha256:c5708d3fff608da8d916fb5ae79dc3e4eba495fca376134a7c607a8e2216405d`.

## Limites verdadeiros

LLM real: `NOT_EXECUTED`. Preview e publicação: `NOT_PRESENT`. Experiência para
pessoas leigas: `NOT_VALIDATED`. Este resultado não afirma que o aplicativo
está pronto ou publicado.
