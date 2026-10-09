# Procedência — mattpocock/skills

- origem: https://github.com/mattpocock/skills
- commit: 3cca18b368ae95cdbdebbff572ccafa662551015
- data_do_commit: 2026-09-04
- copiado_em: 2026-09-11
- licenca: MIT — Copyright (c) 2026 Matt Pocock (ver LICENSE nesta pasta)
- inventario: docs/inventory/p37/mattpocock-skills.md
- decisao: docs/adr/ADR-045-tres-referencias-externas-ferramenta-nao-produto.md

## Aviso de segurança que vale ler antes de instalar qualquer uma

Skill é INSTRUÇÃO executada por um agente com acesso ao disco. O vetor de risco
de um pacote de skills é conteúdo malicioso em PROSA, não defeito de
biblioteca — e nenhum scanner deste repositório alcança isso. O único controle
real é ler o texto da skill antes de instalá-la em qualquer agente.

## O que esta cópia NÃO é

Não é dependência do produto. Nada aqui entra no `pnpm-lock.release.yaml`, no
SBOM ou na imagem distribuível.
