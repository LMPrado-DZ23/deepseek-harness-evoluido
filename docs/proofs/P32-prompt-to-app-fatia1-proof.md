# P32/P33 + P31-B — Prova da fatia vertical 1

- Resultado: **PASS**
- Estado final: `VERIFIED_PROTOTYPE`
- Modelo: fixture determinística; LLM real: `NOT_EXECUTED`
- Imagem do construtor: `sha256:c5708d3fff608da8d916fb5ae79dc3e4eba495fca376134a7c607a8e2216405d`
- Build, Vitest, Playwright e axe: PASS em contêiner sem rede
- Tentativas: 1/3
- Isolamento tenant adversarial: PASS (`org-b` recebeu `NOT_FOUND`)
- Arquivo sentinela fora da raiz: hash antes/depois idêntico `aaa8d3c8d74ad3e8f6b1772aa9c7e0eaa528cb42fc93599ce2f125b00d4c424c`
- Evidências gravadas: `build-log:e551fe6f007784ddeb9f0381c7145cac3d4749a7d16d66c94168929449b36739`, `test-report:34a15399c606892b6c9d2e2fbdfe5d1ac08db575256520adcbb86cbe9e86babc`
- Critérios AppSpec: páginas, seções, idioma, título e texto literal passaram; o critério subjetivo ficou `NOT_AUTOMATED`.
- Preview: `NOT_PRESENT`; publicação: `NOT_PRESENT`; experiência leiga: `NOT_VALIDATED`

Esta prova valida a composição técnica determinística da fatia. Ela não valida qualidade com LLM real, uso por pessoas leigas, celular físico, preview ou deploy.
