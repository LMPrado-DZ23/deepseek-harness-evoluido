# BASELINE-001 — DeepSeek Harness `6c705be`

- Data: 2026-09-01
- Upstream: `https://github.com/deepseek-ai/deepseek-harness.git`
- Commit: `6c705be1ce6774a000d061da41d1823b03a3d42c`
- Estado: conhecida, não verde; zero defeito lógico de produção classe (e) comprovado

## Papel desta baseline

Esta baseline registra o estado do upstream e não é gate de commit do repositório Studio. Pelo D30, cada pacote do Studio usa seus próprios gates: cobertura mínima de 90% e 100% para caminhos de segurança, além de typecheck, lint e testes focados aplicáveis.

Falhas pré-existentes ou de robustez dos testes do Harness ficam no backlog upstream e não são corrigidas dentro do Studio. O gate de composição continua exigindo zero diff no checkout pinado.

## Evidência resumida

- `pnpm typecheck`: PASS.
- `pnpm lint`: PASS.
- Três execuções Linux completas de `pnpm test`: não verdes, com conjuntos variáveis.
- Terceira rodada: 14 falhas com teto padrão de 11 workers.
- Diagnóstico com 2 workers: 4 falhas.
- Contraprovas isoladas: Oxlint excedeu orçamento de 5 s e Spill reproduziu uma fixture de fronteira de `mtime`; ambos classificados como robustez de teste/ambiente, classe (d).
- Classe (e): zero.
- Upstream antes/depois: commit idêntico e árvore limpa.

## Referências de evidência

Artefatos externos ao repositório Studio:

- `outputs/POC-02_BASELINE/baseline-report.md` — SHA-256 `CD9BE227EC072F7177C50A59042CAFF9386C10F04F9B33450033453060519D05`.
- `outputs/POC-02_BASELINE/third-linux-controlled-report.md` — SHA-256 `D307BBF9D7E0A62EF2364F52FB8816F1447EB2C008D1F8C7B4B0968ACCEB8311`.

Os hashes identificam os relatórios revisados usados nesta decisão.
