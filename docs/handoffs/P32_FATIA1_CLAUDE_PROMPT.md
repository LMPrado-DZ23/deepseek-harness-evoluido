# P32/P33 + P31-B — Brief vinculante da fatia vertical 1

Base: `ab0fe506928dacd736262a024d202f3e96e2689d`. Upstream fixado em
`6c705be1ce6774a000d061da41d1823b03a3d42c`, sem diff.

Escopo: Ideia → Perguntas → Plano → Criação → Verificação; sete domínios
tenant-aware; AppSpec v1; template estático v1; geração restrita a `src/` e
`content/`; no máximo três tentativas; API com sessão, CSRF, RBAC e escopo do
servidor; interface React/Vite pt-BR; golden set com 18 briefs.

Invariantes: sem READY/DONE/PUBLISHED/DEPLOYED; sem preview ou deploy; sem rede
no construtor; arquivos originais do template imutáveis; `local-only` nunca usa
rota externa; LLM determinístico não promove o golden set; experiência leiga
continua `NOT_VALIDATED`; código das referências não é incorporado sem P37.

Gates: PostgreSQL real, typecheck, build, cobertura D30, domínios, i18n,
Playwright+axe, isolamento do construtor, pipeline, golden set, P37, composição
real do profile e zero diff upstream. Parar para revisão do Claude antes de
merge, push, PR ou deploy.
