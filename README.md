# DZ23 STUDIO

Produto local composto sobre os seams públicos do DeepSeek Harness sem alterar o
upstream. O nome oficial e o logotipo foram decididos pelo proprietário em
[ADR-003](./docs/adr/ADR-003-product-identity-dz23-studio.md).

O checkout de execução continua fixado no commit
`6c705be1ce6774a000d061da41d1823b03a3d42c`. O primeiro componente de produção
em construção é o motor de permissões `@dz23-studio/policy`, aplicado no seam
host-side `tools/pre-execute`; decisões de segurança não dependem da interface.

O produto será **open source e sem cobrança, assinatura, créditos ou paywall**.
A licença OSI exata ainda precisa ser escolhida antes da publicação; enquanto
`LICENSE.md` não for substituído, o checkout continua juridicamente privado.

## Decisão

**O gate literal original foi encerrado com errata aceita.** O commit fixado rejeita o nome físico `studio.hello`: `defineDomain` aceita somente `/^[a-z][a-z0-9_]*$/`. A convenção geral agora usa `studio_hello` como identificador físico e `studio.hello` como nome lógico.

**Viabilidade arquitetural do núcleo aprovada.** O PoC-01b executado em WSL2 ext4 comprovou sessão live, aprovação, sandbox com negação fora do workspace e preservação após reinício.

Consulte [REPORT.md](./REPORT.md) para comandos, resultados, erros e limitações.

Decisões relacionadas:

- [ADR-001 — identificadores físicos e nomes lógicos](./docs/adr/ADR-001-storage-domain-naming.md)
- [BASELINE-001 — DeepSeek Harness 6c705be](./docs/baselines/BASELINE-001-deepseek-harness-6c705be.md)
- [PoC-01b — prova viva do núcleo no WSL2 ext4](./docs/pocs/POC-01B-runtime-proof.md)

## Estrutura

- `dsh-home/profiles/studio`: profile Studio que estende os bundles oficiais `@deepseek-ai/dsh-base` e `@deepseek-ai/dsh-web-app`.
- `plugins/hello`: plugin externo `@studio/hello`; o upstream não recebe arquivos ou alterações.
- `plugins/policy`: motor TypeScript + Zod dos tiers T0–T3, com auditoria por sessão.
- `plugins/identity`: passkeys, código temporário por e-mail, sessões opacas,
  dispositivos, CSRF e revogação ligados ao motor de permissões.
- `apps/studio-web/public/brand`: identidade visual oficial do DZ23 STUDIO.
- `UPSTREAM.lock`: identidade do repositório e commit usados.

## Verificação focada

No WSL Ubuntu, a partir da raiz deste repositório:

```sh
/home/leandro/harness-studio-poc02/deepseek-harness/node_modules/.bin/tsc -p tsconfig.json --noEmit
node node_modules/vitest/vitest.mjs run --coverage
```

Resultado atual do gate completo P29-A: 107 testes aprovados e 100% de
statements, branches, functions e lines em `hello`, `policy` e `identity`. A
prova viva restaura a sessão de identidade após reinício e comprova que a
revogação bloqueia a chamada de ferramenta seguinte. Isso não inclui cerimônia
de passkey com hardware nem exposição pública.
