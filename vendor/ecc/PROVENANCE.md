# Procedência — ECC

- origem: https://github.com/affaan-m/ECC
- commit: c9148d0bb239ed01a95724a5928b98cdf9c30658
- data_do_commit: 2026-09-10
- copiado_em: 2026-09-11
- licenca: MIT — Copyright (c) 2026 Affaan Mustafa (ver LICENSE nesta pasta)
- inventario: docs/inventory/p37/ecc.md
- decisao: docs/adr/ADR-045-tres-referencias-externas-ferramenta-nao-produto.md

## O que foi REMOVIDO desta cópia, e por quê

A pasta `assets/` do original NÃO está aqui. Ela guarda, entre outras coisas,
`assets/images/sponsors/` — nove arquivos com logotipos de cinco empresas
terceiras (CodeRabbit, Greptile, Atlas Cloud, Moonshot AI/Kimi, Itô Markets),
hospedados no repositório original por relação de patrocínio.

O MIT do ECC licencia o trabalho de Affaan Mustafa. Ele não podia licenciar
marca de outra empresa, e não licenciou. Copiar esses arquivos para cá poria
marca alheia dentro de um repositório que vai ser publicado.

Consequência prática: alguns `<img>` do README e da documentação apontam para
caminhos que não existem nesta cópia. Isso é intencional, e é melhor que a
alternativa.

## O que esta cópia NÃO é

Não é dependência do produto. Nada aqui entra no `pnpm-lock.release.yaml`, no
SBOM ou na imagem distribuível — `vendor/` não está em nenhuma das duas
topologias pnpm, e `gate:vendored-references` prova isso a cada execução.
