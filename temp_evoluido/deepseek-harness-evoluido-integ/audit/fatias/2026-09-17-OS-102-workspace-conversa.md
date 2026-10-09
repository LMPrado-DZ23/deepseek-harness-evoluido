# Fatia — OS-102, a tarefa vira conversa

Registro da entrega que responde à decisão de produto
`DZ23-VISUAL-VIDEO-20260916-R1`. O formato é o de sempre: o que foi pedido, o
que foi feito, onde está ligado, o que foi provado, o que **não** foi, e o que
sobra.

## 1. O que foi recusado, e por quê

O proprietário recusou a captura anterior com uma frase que não é sobre cor:

> "Ela ainda apresenta o assistente antigo de cinco etapas como estrutura
> principal."

A lista do que não podia voltar, do pacote de correção:

| item recusado | estado nesta entrega |
| --- | --- |
| página dominada por "Resultado da verificação" em painéis azul-marinho | o resultado é um lance da conversa; o relatório abre no painel |
| trilho permanente `1. Ideia … 5. Verificação` | não é montado na tela da tarefa (`TaskScreen.spec.tsx`) |
| tarefa num formulário e conversa em outra experiência | uma tela só: enviar na home abre a conversa |
| wizard obrigatório como porta de entrada | não há; o pedido vira tarefa e conversa |
| home com "Continuar" que encaminha ao wizard | "Continuar" cria a tarefa e abre a conversa |
| mudança limitada a tokens, títulos, logo ou nomes de componentes | a estrutura mudou; ver o diff e as capturas |

## 2. O que foi construído

### 2.1 A conversa é uma PROJEÇÃO, não um diário novo

A decisão proíbe, com todas as letras, "criar outra conversa, journal, executor
ou armazenamento paralelo". Nenhum domínio novo foi criado.

`GET /projects/:id` **já devolvia** pedido, turnos de admissão, plano,
tentativas e evidências no mesmo corpo. A tela lia três desses campos e
descartava `turns`, `runs` e `evidence` — e era esse descarte, não a falta de
armazenamento, que fazia a conversa parecer impossível.

| peça | arquivo | o que decide |
| --- | --- | --- |
| a ordem dos lances | `apps/studio-web/src/tarefa/transcricao.ts` | função pura: corpo da tarefa → lances em ordem cronológica |
| para onde vai o envio | `apps/studio-web/src/tarefa/compositor.ts` | função pura: estado → destino; **nenhum** devolve "abrir outra tarefa" |
| a casca da conversa | `apps/studio-web/src/tarefa/TaskScreen.tsx` | histórico central, compositor inferior, painel sob demanda |
| as medidas | `apps/studio-web/src/tarefa/tarefa.css` | coluna legível, borda de 1px, grafite neutro |

As duas primeiras são puras de propósito: a ordem dos lances e a decisão do
envio são o que quebra primeiro quando alguém acrescenta um estado, e uma
decisão dentro de um JSX não é exercitada por teste nenhum.

### 2.2 Continuar a MESMA tarefa exigiu contrato novo

"Pedir uma alteração continua na MESMA tarefa e no MESMO projeto" não tinha
onde acontecer: `POST /plan/change` exige plano `PROPOSED`, e depois de um
resultado o plano está `APPROVED`. Sem ponto de extensão, "continuar" teria de
criar outro projeto — o defeito recusado.

A ampliação é a menor possível e **não** inventa armazenamento:

| peça | arquivo | decisão |
| --- | --- | --- |
| a regra | `plugins/prompt-to-app/src/revision.ts` | o pedido vira **critério de aceite** na especificação |
| o mapa de estados | `plugins/prompt-to-app/src/state.ts:REVISION_TRANSITIONS` | terceiro mapa, separado; só desfecho → `SPEC_READY` |
| o serviço | `service.ts:reviseProject` | grava a especificação ANTES da transição |
| a rota | `http.ts` — `POST /projects/:projectId/revise` | `project.write`, escopo de projeto |
| a volta para a conversa | `revision.ts:pedidosDeRevisao` | deriva o texto da pessoa das especificações gravadas |

Duas ausências são o requisito, e não descuido: a revisão **não** propõe plano
e **não** aprova nada. Depois dela a pessoa vê o plano novo e o aprova, como
sempre. Uma revisão que gerasse sozinha seria gasto sem ninguém olhar.

`origin: 'edit'` já existia no esquema e existia para este caso. **A versão do
domínio não sobe: nenhum registro muda de forma.**

### 2.3 Os seis destinos, com a pendência declarada

A versão anterior do trilho tinha três linhas e uma justificativa escrita para
as ausências. A decisão inverteu a regra: "ausência de função significa
implementar e manter a pendência; não remover o requisito".

| destino | o que mostra | serviço |
| --- | --- | --- |
| Habilidades | catálogo recortado em `skill` | Hub |
| Plugins | catálogo recortado em `mcp`/`webhook`/`smtp`, mais o envio de e-mail | Hub |
| Biblioteca | os **pacotes** que as tarefas produziram: arquivo, tamanho, resumo, data | Hub (`exports`) |
| Agendado | a verdade: a função não existe, e o que falta para existir | nenhum — **pendência declarada** |

`destinos.ts:DISPONIBILIDADE` marca `agendado: 'pendente'` onde um teste
alcança. A tela diz o que falta em vez de mostrar lista vazia; **isto não conta
como capacidade entregue.**

`ESCOPO` é provado disjunto e completo: os dois recortes não se sobrepõem (a
mesma integração em duas telas com ações diferentes) e juntos cobrem os quatro
tipos (um tipo registrado invisível nos dois lugares).

## 3. Achados que a execução produziu

Nenhum destes foi procurado. Todos apareceram medindo.

| achado | como apareceu | correção |
| --- | --- | --- |
| **rota declarada e inalcançável** | `POST /revise` respondia 404 | o casador de caminhos passou a ser **derivado** do contrato de rotas; duas listas viraram uma |
| **ordenação de sufixos era código morto** | a sabotagem que a removia sobreviveu | medido: a alternância do regex **retrocede**. A ordenação saiu; a propriedade ganhou teste próprio |
| **região que rola sem foco** | axe, `scrollable-region-focusable` | `tabIndex={0}` na conversa |
| **página sem marco principal e sem título** | axe, `landmark-one-main` / `page-has-heading-one` | `<main>` e `<h1>` na tela da tarefa |
| **painel escondia o `<main>` no celular** | axe no tamanho de telefone, com painel aberto | o painel passou a **empilhar** em vez de esconder a conversa |
| **a mesma informação duas vezes** | e2e: seletor casando com dois elementos, três vezes | linha do tempo, botão de prévia e "tentar de novo" ficaram em UM lugar cada |
| **plano devolvido para revisão continuava editável** | e2e travou esperando o botão certo | a ação passou a ser decidida pelo **status do plano no servidor**, não por um `null` local |
| **a marca do fim da conversa estava fora da lista que rola** | a conversa não descia sozinha | `scrollIntoView` rola o ancestral com rolagem; a marca foi para dentro do `<ol>` |
| **recarregar no meio das perguntas perdia a pergunta** | ao ligar a restauração completa | `GET /projects/:id` passou a devolver a pergunta aberta, **derivada** dos turnos |

## 4. Provas positivas e negativas

| prova | tipo | resultado |
| --- | --- | --- |
| `apps/studio-web/src/tarefa/transcricao.spec.ts` | unidade | 18 |
| `apps/studio-web/src/tarefa/compositor.spec.ts` | unidade | 13 |
| `apps/studio-web/src/tarefa/TaskScreen.spec.tsx` | montagem estática | 18 |
| `apps/studio-web/src/destinos/destinos.spec.ts` | unidade | 12 |
| `apps/studio-web/src/hub/presentation.spec.ts` (casos novos) | unidade | 5 |
| `plugins/prompt-to-app/tests/revision.spec.ts` | unidade | 17 |
| `plugins/prompt-to-app/tests/revision-service.spec.ts` | integração de domínio (dublê) | 7 |
| `plugins/prompt-to-app/tests/http.spec.ts` (casos novos) | contrato HTTP | 6 |
| `apps/studio-web/tests/capturas.spec.ts` | e2e — a jornada inteira | 1 |

**Dezoito sabotagens, dezoito pegas** — depois de três rodadas. Quatro
sobreviveram na primeira e cada uma teve destino declarado:

1. ordenação de sufixos → **código morto**, removida (a afirmação do comentário
   estava errada; o regex retrocede);
2. condição `state === 'DRAFT'` na pergunta aberta → **redundante**, removida
   (`nextIntakeQuestion` já responde "não há o que perguntar");
3. `revisions` na leitura da tarefa → **buraco**, virou teste;
4. origem `intake` não virar pedido → **buraco**: o teste usava UMA
   especificação e o laço começa na segunda, então a regra nunca era
   exercitada. Ganhou um caso com duas.

## 5. O que NÃO foi provado, e por quê

Separado como a decisão exige — nenhuma coluna substitui a outra.

| dimensão | estado | motivo |
| --- | --- | --- |
| fidelidade visual | **capturas e gravação do build entregue**, em `apps/studio-web/capturas/` | comparação com F01/F16/F17 no mesmo viewport; semelhança é julgamento do proprietário |
| interações de frontend | **PROVADO** — 120 e2e em quatro viewports | Chromium real, build real |
| integração com o servidor | **PROVADO contra o servidor de teste** | serviços reais do produto; o construtor é **dublê** |
| runtime Cordis | `BLOCKED_BY_EXTERNAL_DEPENDENCY` | não há Docker neste ambiente; captura em servidor de teste **não** é prova de perfil |
| provider real | **NÃO PROVADO** | `EB-04` continua aberto: nenhum modelo real escreveu aplicativo aqui |
| segurança e pendências do MASTER | inalteradas | nenhuma política, RLS ou autorização foi tocada |

O estado dos dados nas capturas: **tarefa criada na hora, no servidor de teste,
com construtor de fixture**. Isto é prova de interface e de integração com o
servidor de teste; **não** é prova de geração com IA real.

## 6. O que sobra

1. **Agendado** não tem serviço (`DISPONIBILIDADE.agendado = 'pendente'`).
2. Os **menus ancorados no compositor** (F08–F10: conectores, habilidades,
   computadores) e o **modal de preferências** (F04/F05) não foram construídos
   nesta fatia — a decisão manda fechar home + conversa + compositor +
   resultado primeiro, e depois os catálogos e modais.
3. **Compartilhar** (F18), **uso** (F19) e **arquivos da tarefa** (F20) seguem
   a mesma ordem.
4. `UX-02` continua **PARCIAL**: anexos no compositor (`AT-07`) e o compositor
   contextual (`AT-69`) seguem abertos.
5. O aceite do proprietário **não** está declarado. Ele depende dele.
