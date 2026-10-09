# Ledger de capacidades de terceiros

Uma linha por capacidade **inspirada** em projeto externo. O P37 correspondente
(`docs/inventory/p37/`) responde a pergunta jurídica; este arquivo responde a
arquitetural: o que foi estudado, o que foi reutilizado e o que foi
reimplementado.

A distinção que este ledger existe para manter: **estudar uma ideia não é
copiar código, e copiar código não é adotar uma ideia.** Confundir as duas é
como um projeto acumula risco jurídico achando que está só se inspirando.

| projeto | licença | capacidade estudada | código reutilizado | arquivos derivados | atribuição | risco | decisão |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DeepSeek Harness | ver submódulo | Motor, Cordis, arquitetura de plugins, seams | **Sim — como submódulo pinado**, zero diff | nenhum: composição sobre os seams | commit `6c705be` pinado e verificado por `gate:upstream-pin` | baixo | **É o CORE.** Nada é copiado para dentro; tudo é composto por cima |
| GitHub Spec Kit | MIT (GitHub, Inc.) | Laço constitution → specify → clarify → plan → tasks → implement → converge | Não | nenhum | cópia em `vendor/spec-kit/` com LICENSE e commit de origem | baixo | **Reimplementar.** O laço é o mesmo do nosso Prompt-to-App; a diferença é que o deles escreve para engenheiro revisar no terminal e o nosso arranca a especificação de quem não sabe que está escrevendo uma. Duas ideias adotadas: constituição do projeto e etapa de convergência (ADR-045) |
| mattpocock/skills | MIT (Matt Pocock) | Skills pequenas, adaptáveis e componíveis; progressive disclosure | Não | nenhum | cópia em `vendor/mattpocock-skills/` | baixo | **Ferramenta de construção.** São skills de engenheiro; o produto é para quem não escreve código |
| ECC | MIT (Affaan Mustafa) | Hooks de engenharia, registry de skills, revisão independente | Não | nenhum | cópia em `vendor/ecc/` **sem `assets/`** | **médio** — `assets/images/sponsors/` traz marca de cinco empresas terceiras que o MIT do projeto não licencia | **Não vendorizar o conteúdo de `assets/`.** `gate:vendored-references` reprova se a pasta voltar (ADR-045, ADR-046) |
| Lovable / bolt / v0 / Replit / Devin | proprietárias | Prompt-to-product, iteração visual, prévia ao vivo | **Não pode** | nenhum | citação nominal apenas | alto se copiado | **Reimplementar a ideia.** Os termos vedam derivar e reverter (P37 de cada um). A prévia ao vivo foi construída do zero (ADR-043) |
| Claude Code | proprietária | Disciplina de contexto, delegação, skills, planejamento | **Não pode** | nenhum | citação nominal apenas | alto | Termos Comerciais §D.4 proíbem duplicar o serviço e construir concorrente. Usar como ferramenta, nunca como fonte de design declarada |
| aider, Cline | Apache-2.0 | Edição por patch, laço de teste | Não | nenhum | exigida se copiar | baixo | Copiável cumpridas as obrigações; o proveito está em reimplementar |
| Zed | GPL-3.0-or-later | Editor colaborativo | **Não** | nenhum | — | alto | `gate:licenses` recusa copyleft forte. Decisão: nada |
| Hermes Agent | ver P37 | Autonomia, missões longas, memória | Não | nenhum | — | — | Estudar para T-08 e T-14 |
| WebMCP | W3C Software and Document License 2023 | Protocolo de ferramenta no navegador | Não | nenhum | — | baixo | Implementar **contra** a especificação, como se implementa contra `fetch` |

## Regra de manutenção

Linha nova aqui exige P37 correspondente **antes**. O contrário — inventário
depois da cópia — é o que o P37 existe para impedir, e já pegou dois erros
reais: uma licença que não era MIT (WebMCP) e um MIT que não cobria tudo que
estava na árvore (ECC).
