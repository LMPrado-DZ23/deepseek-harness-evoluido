# Fatia — OS-103: CI vermelha há cinco entregas, e a fidelidade visual medida

## 1. A CI estava vermelha desde a OS-98, e eu não olhei

`gh run list` no repositório:

| execução | commit | resultado |
| --- | --- | --- |
| 35180319540 | `8de60fd` OS-102 | **failure** |
| 35169651267 | `fac4d6e` OS-101 | **failure** |
| 35166352670 | `1288ffe` OS-100 | **failure** |
| 35162007655 | `22d7abe` OS-99 | **failure** |
| 35158480251 | `f656827` OS-98 | **failure** |

Cinco entregas seguidas em que reportei "25 portões EXIT=0" e a CI reprovou.
Os portões locais passavam de verdade; o que faltou foi olhar a CI, que é outro
ambiente e mede outra coisa. **Não anunciei verde falso por descuido de
medição: anunciei o verde da máquina errada.**

### 1.1 Primeira causa efetiva — job "Linux clean clone"

```
plugins/action-approval/src/plugin.ts(3,21): error TS2307:
  Cannot find module '@deepseek-ai/dsh-user-approval'
plugins/action-approval/src/plugin.ts(147,27): error TS2345:
  Argument of type '"approval/request"' is not assignable to parameter of type 'keyof Events'
plugins/action-approval/src/plugin.ts(147,48): error TS7006: Parameter 'req' implicitly has an 'any' type
plugins/action-approval/src/plugin.ts(147,53): error TS7006: Parameter 'next' implicitly has an 'any' type
```

**Quatro erros, UMA causa.** `plugins/action-approval` importa
`@deepseek-ai/dsh-user-approval` e **não o declara** no seu `package.json`. O
`import type` traz a ampliação de `Events`; sem ele, a chave do evento deixa de
pertencer a `keyof Events` e os parâmetros do ouvinte viram `any` implícito.

Por que passa aqui e reprova lá: a árvore de links do pnpm na raiz deixa um
pacote não declarado alcançável quando alguém mais no workspace o declara. A CI
instala com `--frozen-lockfile --filter '@dz23-studio/*...'`, que instala só o
que o workspace declara.

**Correção:** a declaração, mais três linhas no lockfile — e não um
`pnpm install` que reescrevia 43 linhas com churn de `supports-color` sem
relação nenhuma com o defeito.

**Guarda:** `gate:declared-imports`. Ele lê o que está ESCRITO nos `src` e
compara com o que o `package.json` declara; não resolve módulo, porque resolver
usaria justamente a árvore que esconde o defeito. Autoteste com 8 conferências;
a sabotagem que remove a declaração é pega com o nome do pacote impresso. Ele
entrou na lista de portões **e no workflow da CI**.

### 1.2 Segunda causa — job "Windows release contracts"

```
error: 'README precisa declarar a sequência de clone novo'
```

`tests/portability/clean-clone-readme.test.mjs` exige uma seção
`### Primeiro uso em um clone novo` com as oito linhas exatas que a CI executa.
O README tinha "Para desenvolver" e um bloco diferente. **Correção:** a seção,
com a sequência conferida contra `.github/workflows/verify.yml`.

## 2. Fidelidade visual — divergências medidas contra F01 e F16

Comparação da captura do build entregue com os quadros da referência, no mesmo
viewport (1280×800).

### 2.1 Corrigido nesta fatia

| # | divergência | estado |
| --- | --- | --- |
| 1 | seção "Projetos" sem ação de criar | cabeçalho com `+`, e item "Novo projeto" |
| 2 | seção "Tarefas" continha DESTINOS, não tarefas | lista de tarefas **reais** (`GET /projects`), com "Ver todas" |
| 3 | conta como botão "Sair" no topo | rodapé do trilho: avatar com iniciais, nome, ajuda, sino, sair |
| 4 | alto da tela vazio | produto à esquerda e, com tarefa aberta, o nome dela |
| 5 | compositor retangular com botão largo | pílula, rota à esquerda, contador, envio **redondo** |
| 6 | conversa sem avatar | avatar por lance; iniciais reais da sessão para a pessoa |
| 7 | fala da pessoa como filete | bolha com borda fina, como a referência |
| 8 | compositor da tarefa diferente do da home | mesma pílula, com **chip do projeto** |
| 9 | aviso de notificação ocupava uma linha de texto | sino, com a frase no nome acessível |

### 2.2 Divergências que PERMANECEM — medidas, não escondidas

| # | referência | estado aqui | por quê |
| --- | --- | --- | --- |
| A | busca no topo do trilho | **ausente** | não há serviço de busca. Um campo que não busca é botão mudo |
| B | badge "Novo" em Habilidades | **ausente, de propósito** | é marketing da referência; a decisão proíbe importar dados da conta do Manus como constantes |
| C | pílula de créditos (`✦ 191`) | **ausente** | é o ADENDO `DZ23-USO-CUSTOS-API`. Sem medição real, um número ali seria inventado. T-35 |
| D | ícones de provedor no compositor | **só a rota efetiva** | os ícones da referência são das contas dela; o que existe aqui é a rota, e ela está lá |
| E | anexo, microfone, seletor de computador | **ausentes** | `AT-07` e `GEN-06` são AUSENTE. Desenhá-los apagados é o botão mudo que a decisão proíbe |
| F | "Como foi este resultado?" com 5 estrelas | **ausente** | não há serviço de avaliação |
| G | 3 sugestões de próximo passo | **ausentes** | teriam de ser geradas; escrevê-las à mão seria dado encenado |
| H | artefato com "Copiar"/"txt" e código numerado | **parcial** | o resultado abre no painel; o cartão com cópia e download não foi construído |
| I | menus ancorados no compositor (F08–F10) | **ausentes** | fatia seguinte, na ordem que a própria decisão manda |
| J | modal de preferências (F04/F05) | **ausente** | idem |
| K | compartilhar (F18), uso (F19), arquivos (F20) | **ausentes** | idem |

**A semelhança visual não está declarada aceita.** Ela é julgamento do
proprietário. O que esta fatia afirma é que as nove divergências acima foram
fechadas e as onze restantes estão nomeadas.

## 3. O defeito de comportamento apontado pelo Prado — CONFIRMADO

> "Não transforme automaticamente toda mensagem em novo critério de aceite."

Confirmado lendo `destinoDoEnvio`: depois de um resultado, **todo** envio caía
em `ajustar`, e `ajustar` grava o texto como critério de aceite permanente na
especificação. Uma pergunta — "por que falhou?", "quanto custou?" — virava um
critério que a tentativa seguinte tentaria satisfazer.

**Nesta fatia o silêncio acabou:** o compositor DIZ, antes de a pessoa apertar,
que o envio vira um pedido de alteração com plano novo para aprovar.

**A correção completa é T-34** e não está feita: ligar a mensagem simples à
autoridade de conversa que já existe, para perguntar não custar tentativa. Isso
exige integração com o journal existente — e a decisão proíbe criar uma segunda
conversa, então não há atalho honesto aqui.

## 4. O que foi registrado, e NÃO implementado

- **T-35** — ADENDO `DZ23-USO-CUSTOS-API` rev. 1, nas quatro fatias que o
  próprio adendo define, dependente de T-19 porque a autoridade de orçamento é
  a mesma. **Nada dele foi implementado nesta fatia.**
- **T-36** — DZ23 Studio Android via Capacitor, na ordem do próprio prompt.
  **Nada dele foi implementado nesta fatia.** A parte iOS fica `NOT_EXECUTED`
  sem ambiente Apple.

Registrar não é entregar, e esta seção existe para que a diferença não se perca.

## 5. Provas

| prova | tipo | resultado |
| --- | --- | --- |
| `scripts/check-declared-imports.mjs --self-test` | autoteste do portão | 8 conferências |
| `apps/studio-web/src/shell/tarefasDoTrilho.spec.ts` | unidade | 11 |
| `tests/portability/clean-clone-readme.test.mjs` | contrato de README | 2 |
| suíte `studio-web` | unidade + montagem | 609 |
| e2e em quatro viewports | Chromium real, build entregue | 120 |

**Limitação da prova de CI:** o que confirmei localmente é que o erro de tipo
sumiu (`tsc -b apps/studio-web --force`, EXIT=0) e que
`pnpm install --frozen-lockfile` aceita o lockfile. **A CI verde só existe
depois do push**, e será conferida na execução correspondente a este commit.
Até lá, isto é correção com causa identificada — não CI verde comprovada.
