# Harness Studio PoC-01

PoC isolado para avaliar os seams públicos do DeepSeek Harness sem alterar o upstream. O checkout de execução está fixado no commit `6c705be1ce6774a000d061da41d1823b03a3d42c`; `git status --short`, `git diff --stat` e `git diff --cached --stat` terminaram sem saída.

## Decisão

**NO-GO para o gate literal solicitado.** O commit fixado rejeita o nome de domínio `studio.hello`: `defineDomain` aceita somente `/^[a-z][a-z0-9_]*$/`. O plugin conserva `studio.hello` como namespace lógico e usa `studio_hello` como nome físico compatível, mas isso não é apresentado como cumprimento do requisito literal.

**Viabilidade arquitetural parcial.** A composição `base + web + cordis.patch.yml`, o registro dos seams públicos, o provider determinístico e os testes isolados são viáveis. A sessão live com tool/aprovação/sandbox e a preservação após reinício não foram provadas nesta execução; portanto não compõem evidência de aprovação.

Consulte [REPORT.md](./REPORT.md) para comandos, resultados, erros e limitações.

## Estrutura

- `dsh-home/profiles/studio`: profile Studio que estende os bundles oficiais `@deepseek-ai/dsh-base` e `@deepseek-ai/dsh-web-app`.
- `plugins/hello`: plugin externo `@studio/hello`; o upstream não recebe arquivos ou alterações.
- `UPSTREAM.lock`: identidade do repositório e commit usados.

## Verificação focada

No WSL Ubuntu, a partir da raiz deste repositório:

```sh
/home/leandro/harness-studio-poc02/deepseek-harness/node_modules/.bin/tsc -p tsconfig.json --noEmit
node node_modules/vitest/vitest.mjs run --coverage
```

Resultado observado: quatro testes aprovados e 100% de statements, branches, functions e lines para `plugins/hello/src/index.ts`.
