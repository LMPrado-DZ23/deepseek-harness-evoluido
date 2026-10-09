# Referências visuais e de geração

Data: 03/09/2026
Estado: decisão de arquitetura; nenhum código externo incorporado

## Regra comum

Os projetos abaixo são referências de ideias, contratos e fluxos. Nenhum
arquivo, dependência, template, imagem, fonte, prompt ou marca pode entrar no
DZ23 STUDIO antes de um inventário P37 específico, fixado em commit, com
licença por diretório, origem, conteúdo de terceiros, marcas e hashes.

| Projeto | Uso no DZ23 STUDIO | Momento |
| --- | --- | --- |
| `stackblitz-labs/bolt.diy` | geração, diffs, snapshots e recuperação | pesquisa de P32/P33 |
| `ishandutta2007/Open-Laudable` | experiência local-first e linguagem | referência secundária de UX |
| `nexu-io/open-design` | design system, preview isolado e artefatos | fatia 2/P34, não na fatia 1 |

## OpenDesign: ideias aprovadas para estudo na fatia 2

1. `DesignSpec` v1 em Zod, versionada e tenant-aware no domínio físico
   `studio_design_specs`.
2. Escolhas leigas como moderno, profissional, colorido ou minha marca. O
   contrato técnico não é exposto à pessoa; é consumido pelo gerador.
3. Preview em iframe isolado, atrás da autenticação do Studio, com TTL,
   `sandbox` e CSP próprios.
4. Catálogo próprio de templates DZ23, assinado e com versões fixadas.

## Exclusões vinculantes

- Sistemas visuais ou nomes que imitem marcas de terceiros.
- HyperFrames, vídeo e miniaturas de terceiros na v1.0 e v1.x.
- Transplante da interface, stack ou componentes do OpenDesign.
- Marketplace, instaladores automáticos de MCP, proxy BYOK, telemetria ou
  deploy do OpenDesign.
- Prompts, imagens, fontes e templates externos sem inventário individual.

O catálogo do DZ23 STUDIO oferece somente estilos neutros próprios e a marca
fornecida pela própria pessoa. Referência visual não autoriza copiar identidade,
trade dress ou ativos de terceiros.

## Regra para eventual reaproveitamento

Trecho aprovado pelo P37 entra em commit isolado, com repositório, commit e
caminho de origem registrados no `license-inventory.md`. Licenças, avisos e
atribuições aplicáveis são preservados; arquivos modificados são identificados.
Marcas do projeto de origem nunca são usadas para identificar o DZ23 STUDIO.
