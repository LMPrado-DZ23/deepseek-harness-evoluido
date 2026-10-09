# ADR-049 — Os quinze candidatos da V6 foram decididos antes de qualquer instalação

- Estado: Aceita
- Data: 2026-09-16
- Autor: Claude, dentro da autonomia delegada por Prado
- Requisitos correspondentes: `EVO-01`
- Cenários: `AT-113`, `AT-114`

## Contexto

O pacote V6 trouxe `docs/20_REGISTRO_DE_CANDIDATOS.json` com quinze nomes e uma
advertência no próprio arquivo: `REGISTRO_DOCUMENTAL_NAO_DEPENDENCIAS_INSTALADAS`.
O MASTER V6 §46 diz o que fazer com eles e, principalmente, o que **não** fazer:

> A seleção vira registro no mecanismo existente de integração/ADR, não novo
> marketplace ou banco de autoridade.

Essa frase decidiu o desenho. O risco óbvio era instalar demais. O risco real,
que o §46 nomeia e a AT-114 cobra, é outro: **a capacidade sumir junto com o
candidato recusado.** "Não adotamos o Mitosis" vira, três meses depois, "não
fazemos componentes multi-formato", e ninguém percebe a troca.

## Decisão

Um registro em `docs/inventory/candidatos-v6.json`, ao lado dos inventários P37
que já existem, e **um motor de decisão** em `scripts/candidate-registry.mjs`.

A parte que virou código é uma só, e é a que a AT-114 cobra: **um candidato pode
ser promovido a operacional?** O resto — licença, compatibilidade, custo — é
registro, porque depende de leitura humana e de fontes externas.

Ela é código, e não prosa, pelo motivo que esta árvore aprendeu mais de dez
vezes: um documento dizendo "candidato incompatível não é promovido" não impede
ninguém de promover. Uma função que recusa, com teste que falha quando ela para
de recusar, impede.

**Quatro decisões possíveis**, e não duas: aproveitar o conceito, integrar um
componente limitado, reimplementar um contrato pequeno, ou não adotar. Sim/não
esconderia justamente as duas saídas que mais valem aqui — e empurraria toda
necessidade real para uma instalação.

**Todo candidato nomeia a capacidade e a autoridade que já a possui.** Recusar
não mexe em nenhuma das duas, e o portão acusa um registro que apagaria a
capacidade.

**Campo não conferido fica `DESCONHECIDO`**, e ausência conta igual. É a mesma
regra que o portão do P37 aplica desde que existe, pelo mesmo motivo: um campo
que sumiu e um campo por conferir produzem a mesma ignorância.

## O resultado, que é o correto

Quinze decididos, **zero instalados, zero capacidades perdidas**.

| decisão | quantos | quais |
| --- | --- | --- |
| `EM_ESTUDO` | 2 | OpenDesign (estudo dirigido, §46) e Lemonade |
| `APROVEITAR_CONCEITO` | 3 | DTCG, MCP (já em uso), Aider |
| `NAO_ADOTAR` | 10 | os demais, cada um com motivo escrito |

Dois pontos que valem mais que a contagem:

**O Lemonade é o único candidato com lacuna MEDIDA.** O Ollama da máquina do
Prado não completa o prompt real em 45 s (`EB-04`), e isso está registrado com
número. Os outros catorze foram avaliados contra lacunas observadas ou contra a
ausência delas — metade tem "nenhuma lacuna observada", que é uma resposta, e a
mais honesta.

**`open-design` genérico ficou SEPARADO de `nexu-io/open-design`.** O texto de
origem usa o nome de forma genérica. Uni-los seria decidir sobre um projeto por
causa do nome de outro, e é perigoso justamente por parecer resolvido. Há teste
que falha se alguém os fundir.

## Consequências

`gate:candidates` passa a ser o vigésimo segundo portão. Ele recusa duas coisas:
um candidato marcado operacional que não sustenta a promoção, e um registro que
apagaria a capacidade.

Nada foi instalado, nada foi baixado, nenhuma licença foi declarada aprovada e
nenhum pin foi inventado. O §02 é explícito: este pacote não autoriza instalação,
e `instalacao_autorizada` é campo do registro justamente para que uma promoção
futura precise de uma decisão do Prado, e não de um arquivo.

Recusar um candidato **não** encerra a capacidade correspondente. As que não têm
dono hoje — nativo para celular, telefonia, agentes externos — continuam
rastreadas como ausentes, que é a verdade sobre elas.
