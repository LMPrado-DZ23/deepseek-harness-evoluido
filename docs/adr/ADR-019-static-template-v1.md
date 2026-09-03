# ADR-019 — Template estático v1 como desvio temporário

Status: substituído pelo ADR-021; preservado como fallback explícito de manutenção.

A fatia 1 usa `templates/static-site@1`: Vite, React 18, TypeScript estrito,
Tailwind, Vitest, Playwright e axe, com versões e lockfile fixados. O objetivo é
provar o pipeline com o menor conjunto de variáveis. Next.js, banco e login do
aplicativo gerado entram somente na fatia 2, depois que este caminho estiver
estável.

O setup com rede é T2 e acontece uma vez. A geração usa store offline, lockfile
congelado e scripts de dependências desativados. O modelo só escreve em `src/`
e `content/`, somente nos arquivos aprovados no plano, e nunca altera arquivos
originais do template.

Desde a fatia 2, nenhuma categoria usa este template por padrão. Selecioná-lo
exige configuração explícita e nunca ocorre como fallback silencioso de uma
falha no template Next.js.
