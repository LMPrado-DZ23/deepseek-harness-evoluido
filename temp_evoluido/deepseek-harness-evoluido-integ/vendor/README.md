# vendor/ — referências externas copiadas, não dependências

Esta pasta guarda cópias de repositórios de terceiros que Prado pediu para ter
dentro do projeto, em 11/09/2026. Cada uma tem `LICENSE` e `PROVENANCE.md` com a
URL de origem, o commit exato e a data da cópia.

| pasta | origem | licença | commit |
| --- | --- | --- | --- |
| `ecc/` | affaan-m/ECC | MIT (Affaan Mustafa) | `c9148d0` |
| `mattpocock-skills/` | mattpocock/skills | MIT (Matt Pocock) | `3cca18b` |
| `spec-kit/` | github/spec-kit | MIT (GitHub, Inc.) | `c173bf1` |

## A regra que governa esta pasta

**Nada aqui é dependência do produto.** `vendor/` não aparece em
`pnpm-workspace.yaml` nem em `pnpm-workspace.release.yaml`, então nenhum pacote
daqui entra no lockfile, no SBOM ou na imagem distribuível. O
`gate:vendored-references` prova isso a cada execução, em vez de deixar a
afirmação de pé sozinha.

**`vendor/ecc/assets/` não existe, e a ausência é deliberada.** O original
guarda ali logotipos de cinco empresas terceiras, que o MIT do ECC não podia
licenciar porque não eram dele. O portão reprova se a pasta reaparecer.

**Cópia envelhece.** Estes três são fotografias de um commit, não submódulos:
não atualizam sozinhos e não avisam quando ficam para trás. Para atualizar
qualquer um, refaça o P37 correspondente com data nova (o inventário é o que
registra licença e marca, e as duas coisas mudam), copie de novo e atualize o
commit no `PROVENANCE.md`.

## Por que MIT não basta como resposta

Os três são MIT, e a leitura preguiçosa pararia aí. O MIT de um repositório
licencia o trabalho do licenciante — e não pode licenciar obra de terceiro que
esteja hospedada na árvore dele. Foi exatamente esse o achado do P37 do ECC, e é
a razão de `assets/` ter ficado de fora. Ver `docs/adr/ADR-045-...md`.
