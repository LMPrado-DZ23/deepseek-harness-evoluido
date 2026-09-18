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
| `EMP-03` | `BUS-03` | A evidência volta para a empresa: cada tarefa mostra os pacotes que produziu | `BUS-16` | PARCIAL | O relato mostra **pacotes**. Faltam o que mudou, consumo, bloqueios, próxima ação, e a cobertura/período/fonte/ambiente dos indicadores. `BUS-03` (oferta, catálogo e preço) **não é tocada por esta entrega** |

## O que isto NÃO muda

Nenhuma das 24 obrigações canônicas passa a estar fechada por causa deste
arquivo. `BUS-02` e `BUS-03` continuam **AUSENTES**, com zero linha de código:
não existe pesquisa de mercado, nem oferta, catálogo ou precificação em lugar
nenhum do produto. As outras vinte e uma também continuam como a matriz as
descreve.
