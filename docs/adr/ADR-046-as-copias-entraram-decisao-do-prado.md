# ADR-046 — As cópias entraram: a ADR-045 foi revertida por Prado

- Estado: Aceita
- Data: 2026-09-11
- Substitui: ADR-045-tres-referencias-externas-ferramenta-nao-produto
- Autor: Claude (Opus 5), executando decisão de Prado
- Requisitos correspondentes: `REF-ecc`, `REF-mattpocock-skills`, `REF-spec-kit`

## O que aconteceu

Prado pediu "coloque esses repositorios no projeto tambem". Eu inventariei os
três, decidi por conta própria **não** copiar, e registrei essa decisão na
ADR-045 com a segurança de quem foi perguntado — quando não tinha sido. Ele
voltou e perguntou: *"voce colocou?"*.

A resposta era não. O pedido era sim. **A ADR-045 respondeu a uma pergunta que
ele não fez.**

Esta ADR corrige isso. As três cópias estão em `vendor/`, e a decisão de tê-las
é dele.

## O que continua valendo da ADR-045

O inventário, e o achado que ele produziu. Isso não era opinião:
`assets/images/sponsors/` do ECC guarda logotipos de cinco empresas terceiras
(CodeRabbit, Greptile, Atlas Cloud, Moonshot AI/Kimi, Itô Markets), que o MIT de
Affaan Mustafa não podia licenciar porque não eram dele.

Então a cópia do ECC entrou **sem `assets/`**, e `gate:vendored-references`
reprova se a pasta voltar. Essa parte não é preferência minha: é a diferença
entre publicar código de terceiro sob licença que o autoriza e publicar marca
alheia sob licença que não a cobre.

## As condições em que as cópias entraram

1. **`vendor/` não é topologia.** Nenhuma das três está em
   `pnpm-workspace.yaml` nem em `pnpm-workspace.release.yaml`, e nada delas
   aparece nos dois lockfiles. O portão confere os quatro arquivos, pelo nome de
   cada cópia — e ancorado no nome porque o Harness pinado tem um `vendor/`
   próprio, que reprovaria por homonímia.
2. **Cada cópia carrega `LICENSE` e `PROVENANCE.md`** com origem, commit
   completo de 40 hexadecimais, data do commit e data da cópia. Commit
   abreviado reprova: ele volta a ser ambíguo quando a árvore cresce, e a
   procedência deixa de provar de onde a cópia veio.
3. **`vendor/ecc/assets` é proibido por nome no portão.**
4. **A varredura de segredo passou a enxergar as cópias.** Isto é o que mais
   mudou de fato — ver abaixo.

## O que a varredura encontrou, e por que isso importa

Antes da cópia, `gate:secrets` lia 1.364 arquivos. Depois, 5.734 — e reprovou
com **28 achados**, todos no ECC.

Nenhum foi dispensado por ser de terceiro. Cada linha foi aberta e lida. Todas
as 28 são sintéticas, e a maioria tem a mesma origem divertida: são fixtures do
detector de segredo **do próprio ECC** — `a chave de exemplo que a propria AWS publica na documentacao dela (prefixo AKIA, sufixo EXAMPLE)` (a chave de
exemplo que a própria AWS publica), `sk-ant-api03-FAKEFAKEFAKE...000000`, um RSA
truncado em `MIIE...`, e `postgres:postgres@db` de um docker-compose de
desenvolvimento. Dois projetos que procuram a mesma coisa se acusam mutuamente.

As 19 isenções entraram uma a uma, nomeando arquivo **e** regra, com o motivo
escrito. Isentar `vendor/` inteiro com uma linha seria mais rápido e seria o
erro: a cópia está no repositório público, então ela é nossa responsabilidade
como qualquer outro arquivo, e um segredo real dentro dela vazaria com o nosso
nome. A prova de que a isenção não é um cheque em branco: um token do GitHub
plantado no mesmo arquivo já isento para `private-key` **reprova**, porque a
dispensa é por arquivo E regra.

## O custo, dito sem enfeite

O repositório cresceu ~57 MB e ~4.376 arquivos. Isso é real, e é o preço de ter
tudo num lugar só. Três consequências que ninguém deve descobrir depois:

- **Cópia envelhece em silêncio.** Não são submódulos: não atualizam sozinhas e
  não avisam quando ficam para trás. Atualizar qualquer uma exige refazer o P37
  com data nova, porque licença e marca mudam.
- **Alguns `<img>` do README do ECC apontam para o nada**, porque `assets/` não
  veio. É intencional, está escrito no `PROVENANCE.md`, e é melhor que a
  alternativa.
- **Nada disso vira produto por estar aqui.** Continuam sendo ferramenta de
  quem constrói. O que a ADR-045 dizia sobre isso segue de pé: são camadas
  diferentes do DZ23 STUDIO, e a proximidade no disco não muda isso.

## A lição de processo, que é a parte que eu deveria ter feito diferente

Eu tinha os dados para recomendar e recomendei bem. O erro não foi a análise —
foi tratar a recomendação como decisão e registrá-la em ADR como se estivesse
fechada. Um pedido direto ("coloque") merece ou a execução, ou a objeção na hora
com a pergunta junto. O que não serve é entregar a análise no lugar do pedido e
chamar isso de autonomia.
