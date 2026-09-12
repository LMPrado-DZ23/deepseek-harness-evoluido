# ADR-045 — ECC, mattpocock/skills e Spec Kit entram como ferramenta, não como produto

- Estado: Substituída
- Data: 2026-09-11
- Ressalva: o INVENTARIO e o ACHADO desta ADR continuam validos e sao a razao de `vendor/ecc/assets/` nao existir
- Substituida por: ADR-046-as-copias-entraram-decisao-do-prado
- Autor: Claude (Opus 5), dentro da autonomia delegada por Prado
- Requisitos correspondentes: `REF-ecc`, `REF-mattpocock-skills`, `REF-spec-kit`

> **SUPERADA em 11/09/2026 pela
> [ADR-046](ADR-046-as-copias-entraram-decisao-do-prado.md).**
> A decisão de NÃO copiar registrada abaixo era minha, não do Prado — ele tinha
> pedido para colocar, e eu entreguei a análise no lugar do pedido. As três
> cópias estão em `vendor/`. O INVENTÁRIO e o ACHADO desta ADR continuam
> válidos e são a razão de `vendor/ecc/assets/` não existir.
>
> A decisão original, enquanto valeu, era **reversível**: nada tinha sido
> copiado, e desfazê-la era apagar três documentos.

## Contexto

Prado pediu, com estas palavras: *"coloque esses repositorios no projeto
tambem"*, e listou três:

- https://github.com/affaan-m/ECC
- https://github.com/mattpocock/skills
- https://github.com/github/spec-kit

O prompt mestre é explícito: **toda referência externa exige um P37 específico
ANTES de qualquer cópia.** Então o primeiro ato não foi copiar, foi inventariar.
Os três inventários estão em `docs/inventory/p37/` e o `gate:p37` agora exige os
três pelo nome — apagar qualquer um reprova o portão.

Diferente dos nove inventários anteriores, estes três foram feitos com a árvore
**real** em mãos: o clone por HTTPS funciona neste ambiente (a API do GitHub
não, ela responde 403 para qualquer repositório). Os clones foram para um
diretório efêmero de inspeção, fora da árvore do produto, e nada de lá foi
movido para cá.

## O achado que muda a decisão

Os três são MIT. A leitura preguiçosa pararia aí e concluiria "pode copiar".

Só que **o MIT de um repositório não pode licenciar obra que não é do
licenciante**. No ECC, `assets/images/sponsors/` guarda nove arquivos com
logotipos de cinco empresas terceiras — CodeRabbit, Greptile, Atlas Cloud,
Moonshot AI (Kimi) e Itô Markets. Estão ali por relação de patrocínio. Affaan
Mustafa não tinha direito sobre essas marcas para conceder a ninguém, e o MIT
dele não os concede.

Um `git clone` seguido de `cp -r` teria posto marca alheia dentro de um artefato
que vai ser publicado. É exatamente o tipo de erro que o P37 existe para pegar, e
é a segunda vez que ele pega: no REF-webmcp o achado foi uma licença que não era
MIT, aqui é um MIT que não cobre tudo.

## A decisão

Os três entram como **ferramenta de construção**, não como código de produto.
Nenhum arquivo dos três está na árvore. Nada entra em `pnpm-lock.release.yaml`,
no SBOM ou na imagem distribuível.

**ECC** — não vendorizar. Três razões independentes, cada uma suficiente: a
licença não cobre `assets/`; é um sistema operacional de harness para
desenvolvedor, camada diferente de um produto para leigo; e absorver outro
harness inteiro contraria a composição sobre os seams com zero diff no upstream,
congelada no Plano Mestre v2.0. Se for usado, é externo, versão fixa, desligado
por padrão.

**mattpocock/skills** — não copiar. São skills de engenheiro (TDD, revisão de
código, modelagem de domínio) e o DZ23 STUDIO é para quem não escreve código.
Instalar no ambiente de quem constrói é reversível e atualiza sozinho; copiar
congela a versão e cria dívida de atribuição.

**Spec Kit** — não vendorizar, e é o caso mais interessante dos três, porque o
que ele tem de valioso **nós já temos**. O laço dele é constituição →
especificação → plano → tarefas → implementação → convergência. O nosso é Ideia
→ Perguntas → Plano → Criação → Conferência. É o mesmo laço, com uma diferença
que importa: o Spec Kit escreve a especificação para um engenheiro revisar no
terminal, e o nosso arranca a especificação de alguém que não sabe que está
escrevendo uma.

## O que vale a pena absorver, e o que não vale

Vale registrar duas ideias do Spec Kit como referência de design, porque ambas
atacam buracos que o `P-07` já mediu:

1. **A constituição do projeto** — princípios definidos UMA vez por projeto, que
   valem para todas as gerações seguintes. No nosso caso o equivalente seria o
   perfil do negócio como contexto persistente, que já está no roadmap sem prazo.
2. **A etapa de convergência** — conferir a implementação CONTRA a especificação
   depois de construir, em vez de confiar que a construção seguiu o plano.

Não vale copiar template nenhum: os templates deles são markdown para agente de
terminal, e a nossa tela não mostra markdown para ninguém.

## O que esta ADR NÃO autoriza

Não autoriza copiar arquivo. Não autoriza instalar nada no artefato. Não
autoriza usar o nome ou o logotipo de ECC, Spec Kit, GitHub, Matt Pocock ou de
qualquer patrocinador do ECC em material nosso — o MIT não concede marca, nos
três casos.

Qualquer cópia futura reabre o P37 correspondente, com data nova, e vem com o
aviso de copyright do titular e o commit de origem. E, no caso do ECC, jamais
qualquer coisa sob `assets/`.

## Lacuna assumida, e por que ela não bloqueia

Os três inventários registram `cves_conhecidas` como `NAO_VERIFICADO` com o
mesmo motivo real: a API do GitHub responde 403 nesta sessão, e o Advisory
Database não pôde ser consultado. Isso não bloqueia esta decisão **porque a
decisão é não consumir**. Bloqueia a decisão contrária: se um dia algum dos três
for consumido de verdade, a consulta de advisory é pré-requisito, e o ECC é o que
mais pede — mantenedor único declarado no próprio README, publicação em npm e
superfície grande é a combinação que mais produz incidente de cadeia de
suprimentos.
