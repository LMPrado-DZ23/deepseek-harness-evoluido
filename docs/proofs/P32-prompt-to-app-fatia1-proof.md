# P32/P33 + P31-B — Prova da fatia vertical 1

- Resultado: **PASS**
- Estado final: `VERIFIED_PROTOTYPE`
- Modelo: fixture determinística; LLM real: `NOT_EXECUTED`
- Imagem do construtor: `sha256:51af5f3dbaebc1e9fa37512160a114fdd339eaffacca40e2e3a9b1a1520e5a03`
- Build, Vitest, Playwright e axe: PASS em contêiner sem rede
- Tentativas: 1/3
- Isolamento tenant adversarial: PASS (`org-b` recebeu `NOT_FOUND`)
- Arquivo sentinela fora da raiz: hash antes/depois idêntico `aaa8d3c8d74ad3e8f6b1772aa9c7e0eaa528cb42fc93599ce2f125b00d4c424c`
- Evidências gravadas: `build-log:1d56478527ae601b4cd7ed3a835a8c250ede5a36505c24e27e90f21de119b002`, `test-report:34a15399c606892b6c9d2e2fbdfe5d1ac08db575256520adcbb86cbe9e86babc`
- Critérios AppSpec: páginas, seções, idioma, título e texto literal passaram; o critério subjetivo ficou `NOT_AUTOMATED`.
- Preview: `NOT_PRESENT`; publicação: `NOT_PRESENT`; experiência leiga: `NOT_VALIDATED`

Esta prova valida a composição técnica determinística da fatia. Ela não valida qualidade com LLM real, uso por pessoas leigas, celular físico, preview ou deploy.
