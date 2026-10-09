# Correspondência entre as entregas do Modo Empresa e a matriz canônica BUS

> **Este arquivo existe porque um rótulo estava errado, e o rótulo errado é o
> defeito — não a entrega.**

## O que aconteceu

Três fatias do Modo Empresa foram entregues em 17/09/2026 com os rótulos
`BUS-01`, `BUS-02` e `BUS-03` no livro mestre e nas mensagens de commit
`a77800f`, `7764091` e `6c66fe4`. Dois desses rótulos **colidem com
identificadores da matriz canônica que significam outra coisa**:

- na matriz, `BUS-02` é **pesquisa, validação e hipóteses de mercado**;
- na matriz, `BUS-03` é **oferta, catálogo e precificação revisáveis**.

O que foi entregue com esses números foi "criar tarefa a partir da empresa" e
"ver os pacotes que a tarefa produziu". São coisas úteis e provadas — e não são
aquelas duas obrigações.

Fechar uma obrigação canônica **por coincidência de número** é a pior forma de
declarar pronto: ninguém mente, ninguém verifica, e a matriz passa a dizer que
existe o que não existe.

## A regra

1. **A matriz canônica é a autoridade.** Ela não é renumerada, reescrita nem
   reordenada para acomodar a ordem em que o trabalho aconteceu.
2. **O livro mestre usa identificadores LOCAIS** (`EMP-NN`) para as entregas do
   Modo Empresa. Um identificador `BUS-NN` no livro mestre significaria que a
   obrigação canônica inteira fechou, e nenhuma fechou.
3. **A ponte é esta tabela**, e ela diz o que cada entrega TOCA e o que
   continua faltando para a obrigação fechar.
4. `gate:bus-matriz` prova as três coisas acima.

## A correspondência, por significado

| entrega local | rótulo que tinha (errado) | o que ela faz de verdade | obrigação canônica que ela TOCA | estado da obrigação | o que falta para ela fechar |
| --- | --- | --- | --- | --- | --- |
| `EMP-01` | `BUS-01` | Empresa criada ou vinculada, com plano versionado, revisão que preserva a versão anterior, e arquivamento | `BUS-01` | PARCIAL | `ativos`, `responsabilidades` e `aceites` não são persistidos — o plano guarda objetivo, público, oferta e limites, e mais nada. A distinção entre empresa operacional e entidade jurídica existe (`identidade_juridica_declarada`) e é declarada, não inferida |
| `EMP-02` | `BUS-02` | A tarefa nasce da empresa, com o plano dentro do briefing, e o vínculo guarda a versão do plano que valia | `BUS-22` | PARCIAL | O fluxo do Modo Empresa tem duas superfícies (cadastro/plano e tarefas). Faltam Visão geral, Produto, Marketing, Clientes/Vendas, Atendimento, Financeiro, Operação e o seletor de empresa. `BUS-02` (pesquisa de mercado) **não é tocada por esta entrega** |
| `EMP-02-CI` | `BUS-03-CI` | A sétima causa de CI: pré-condição acidental entre casos do e2e | nenhuma | — | é correção de processo, não de requisito |
| `EMP-04` | — | Catálogo de ofertas: entrega, público, preço/moeda, capacidade, condições, custos declarados, versões e aprovação por versão | `BUS-03` | PARCIAL | A oferta existe, é versionada e é aprovada com as condições dentro da versão. Falta o CATÁLOGO como coisa publicável — não há vitrine, link, página nem qualquer superfície que mostre a oferta a quem não é da empresa, e isso é deliberado enquanto não houver decisão de publicação |
| `EMP-03` | `BUS-03` | A evidência volta para a empresa: cada tarefa mostra os pacotes que produziu | `BUS-16` | PARCIAL | O relato mostra **pacotes**. Faltam o que mudou, consumo, bloqueios, próxima ação, e a cobertura/período/fonte/ambiente dos indicadores. `BUS-03` (oferta, catálogo e preço) **não é tocada por esta entrega** |

## O que isto NÃO muda

Nenhuma das 24 obrigações canônicas passa a estar fechada por causa deste
arquivo. A tabela acima diz o que cada entrega TOCA, e tocar não é fechar.

- `BUS-02` (pesquisa, validação e hipóteses de mercado) continua **AUSENTE**,
  com zero linha de código. Nenhuma das entregas do Modo Empresa a toca.
- `BUS-03` (oferta, catálogo e precificação revisáveis) está **PARCIAL** desde
  `EMP-04`. Existe oferta: entrega, público, preço e moeda, capacidade,
  condições, custos declarados, versões e aprovação por versão — em
  `plugins/business/src/oferta.ts`, `plugins/business/src/model.ts` e
  `apps/studio-web/src/empresa/oferta.ts`. O que falta é o CATÁLOGO como coisa
  publicável: não há vitrine, link nem página que mostre a oferta a quem não é
  da empresa, e essa ausência é deliberada enquanto não houver decisão de
  publicação.

As outras vinte e duas continuam como a matriz as descreve.

> **Histórico, e não estado.** Até o instantâneo `a04b0d6` (18/09/2026) este
> parágrafo dizia que `BUS-02` **e** `BUS-03` estavam ausentes, com zero linha,
> e que não havia oferta nem precificação em lugar nenhum do produto. Isso ficou
> falso quando `EMP-04` entrou, e a tabela acima — no mesmo arquivo — já dizia o
> contrário. Uma revisão externa achou a contradição. O conserto é do parágrafo:
> o código de `EMP-04` está entregue e provado, e não se refaz porque uma frase
> envelheceu. `gate:bus-matriz` passou a conferir que a conclusão e a tabela
> falam da mesma coisa.
