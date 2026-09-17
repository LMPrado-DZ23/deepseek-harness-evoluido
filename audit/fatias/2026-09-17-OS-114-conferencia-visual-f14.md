# Fatia — OS-114: a conferência visual que o dono mandou eu fazer antes de pedir aceite

> "Compare cada tela alterada com o frame correspondente. Registre diferenças
> objetivas e corrija as que estiverem sob seu controle antes de pedir meu
> aceite. Meu aceite final não substitui sua responsabilidade."

Comparei a Biblioteca entregue com o quadro **F14**, no mesmo viewport.

## 1. As seis divergências, e o que aconteceu com cada uma

| # | F14 | estava aqui | desfecho |
| --- | --- | --- | --- |
| 1 | o acervo começa logo abaixo do título | a **declaração** da OS-110 ocupava a primeira dobra | **CORRIGIDO** — recolhida em `<details>`; continua obrigatória e a um clique, mas deixou de ser a manchete |
| 2 | agrupado **por projeto**, com o instante do mais recente à direita | lista única com um seletor de tarefa | **CORRIGIDO** — grupo por tarefa, com cabeçalho e instante |
| 3 | **cartões em grade** | uma coluna de linhas altas | **CORRIGIDO** — grade de 320px mínimo, que cai para uma coluna sozinha em tela estreita |
| 4 | **busca de arquivos** no topo | ausente | **permanece** — não há serviço de busca; um campo que não busca é botão mudo |
| 5 | **abas por tipo** (Slides, Sites, Documentos…) | ausente | **permanece** — esta Biblioteca guarda UM tipo, e a declaração diz isso. Abas de tipos que não existem seriam abas mudas |
| 6 | favoritar e alternador grade/lista | ausentes | **permanece** — nenhum dos dois existe |

Três eram minhas. As três foram corrigidas antes de pedir o aceite.

## 2. O que a captura de entrega revelou

**`Baixar {file}`** — o marcador do catálogo chegando à tela sem ser
preenchido. A frase estava certa; quem a usava não preenchia. Nenhum teste
olhava para o TEXTO do link, então ele saiu numa captura de entrega assim.

Corrigido, com teste: o nome do arquivo entra no rótulo, e uma asserção separada
garante que `{file}` não aparece na página.

## 3. Dois acertos de acessibilidade que as mudanças cobraram

- a declaração virou `<details>` e perdeu o `<h2>`; a hierarquia passou a pular
  de `h1` para os `h3` de dentro (`heading-order`). Um `<h2>` sr-only devolveu a
  ordem sem repetir a frase na tela;
- os grupos eram `<section aria-label={nome}>`. Duas tarefas com o **mesmo
  nome** — que é o caso comum, porque o nome sai do pedido — produziam dois
  **marcos indistinguíveis** (`landmark-unique`). Viraram `<div>`: o `<h2>` do
  cabeçalho já dá a navegação por títulos, que é a certa para grupos.

## 4. Provas

| prova | resultado |
| --- | --- |
| `acervo.spec.ts` | 7 |
| suíte `studio-web` | 670 |
| 26 portões | `GATES_FAIL=0` |
| e2e nos quatro tamanhos, com axe | 141 passaram / 3 pulados, **zero violações** |

**O aceite visual continua sendo do titular e NÃO está declarado.** O que esta
fatia afirma é que as divergências sob meu controle foram medidas e fechadas, e
que as três restantes têm motivo escrito.
