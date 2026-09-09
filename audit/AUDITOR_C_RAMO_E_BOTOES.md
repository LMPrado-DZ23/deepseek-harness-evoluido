# AUDITOR C — Produto / QA / UX

**Objeto:** commit `04128c5` — "tela: o ramo dá um começo melhor, e três botões param de mentir sobre o clique"
**Método:** usar o produto. 40 pedidos escritos como leigo brasileiro escreve, medidos com `npx tsx` contra `categoryGuess`;
comparação A/B contra a árvore anterior (`04128c5^`); testes Playwright escritos por mim que ATRASAM a resposta do servidor;
quatro mutações de falsificação. Tudo restaurado — `git status --porcelain` limpo no fim (só o arquivo de outro auditor).

---

## PLACAR POR ITEM

| # | Item do commit | Veredito |
|---|---|---|
| 1 | O ramo dá um começo melhor que o padrão | **CORRIGIDO** — 22/40 → 30/40 no meu corpus, zero regressão nele |
| 2 | O ramo NÃO liga `understood` (código) | **CORRIGIDO** — e protegido por teste (falsificação 2 reprova) |
| 3 | A separação "escolhi pelo ramo" × "entendi o texto" chega à PESSOA na tela | **NÃO CORRIGIDO** — a tela contradiz a si mesma (C-01) |
| 4 | Os três botões da tela de perguntas ficam ocupados | **CORRIGIDO** — provado por teste meu com resposta atrasada |
| 5 | Os três botões têm rótulo e `aria-busy` | **PARCIAL** — os atributos existem, mas ninguém os ouve (C-04) |
| 6 | "Nenhum botão do fluxo principal manda pedido sem avisar" | **NÃO CORRIGIDO** — provado FALSO: 4 botões sobraram (C-02) |
| 7 | A correção dos três botões está protegida contra regressão | **NÃO CORRIGIDO** — zero testes; falsificação 1 passa em branco (C-03) |

---

## AS 40 FRASES

Escritas por mim como uma pessoa leiga brasileira escreve: curtas, sem acento, com erro de grafia,
em CAIXA ALTA, com gíria e regionalismo. "antes" = comportamento em `04128c5^`.

| # | texto | antes | depois (palpite) | `understood` | devia ser | ok? |
|---|---|---|---|---|---|---|
| 1 | sistema pra barbearia | landing-page | **scheduling** | false | scheduling | OK ▲ |
| 2 | APP DE DELIVERY PRA MINHA LANCHONETE | landing-page | **catalog** | false | catalog | OK ▲ |
| 3 | quero um sisteminha pro meu petshop | landing-page | **catalog** | false | catalog | OK ▲ |
| 4 | preciso de um site pra minha loja de roupa | landing-page | landing-page | true | landing-page | OK |
| 5 | pagina da minha loja pra mostrar quem somos | landing-page | landing-page | true | landing-page | OK |
| 6 | ajenda pro salao de beleza | scheduling | scheduling | true | scheduling | OK |
| 7 | marcar hora no dentista | scheduling | scheduling | true | scheduling | OK |
| 8 | CARDAPIO DIGITAL DA PIZZARIA | catalog | catalog | true | catalog | OK |
| 9 | um negocio pra clientes marcar horario comigo | scheduling | scheduling | true | scheduling | OK |
| 10 | quero guardar os nome dos meus cliente | landing-page | landing-page | false | form-database | ERRO |
| 11 | controle de quem me deve | form-database | form-database | true | form-database | OK |
| 12 | sistema pra oficina mecanica | landing-page | **crud-panel** | false | crud-panel | OK ▲ |
| 13 | preciso saber quanto vendi no mes | dashboard | dashboard | true | dashboard | OK |
| 14 | PAINEL PRA MINHA EQUIPE MEXER NOS DADOS | crud-panel | crud-panel | true | crud-panel | OK |
| 15 | cada cliente com login proprio | saas-auth | saas-authenticated | true | saas-authenticated | OK |
| 16 | app pra igreja | landing-page | landing-page | false | landing-page | OK |
| 17 | quero divulgar meu trabalho de fotografo | landing-page | landing-page | true | landing-page | OK |
| 18 | sistema pra academia | landing-page | landing-page | false | scheduling | ERRO |
| 19 | um app pra escola dos meus filhos | landing-page | landing-page | false | landing-page | OK |
| 20 | quero vender bolo pela internet | catalog | catalog | true | catalog | OK |
| 21 | coisa pra anotar as horas dos funcionario | form-database | form-database | true | form-database | OK |
| 22 | site da minha imobiliaria com os imoveis | landing-page | landing-page | true | catalog | ERRO |
| 23 | quero um lugar pro pessoal se inscrever no curso | landing-page | landing-page | false | form-database | ERRO |
| 24 | sistema de ordem de servico | crud-panel | crud-panel | true | crud-panel | OK |
| 25 | sistema pra advogado | landing-page | landing-page | false | landing-page | OK |
| 26 | app pro meu food truck | landing-page | landing-page | false | catalog | ERRO |
| 27 | quero um site simples so pra falarem comigo | landing-page | landing-page | true | landing-page | OK |
| 28 | negocio pra clinica organizar os pacientes | landing-page | **scheduling** | false | scheduling | OK ▲ |
| 29 | queria um app tipo ifood pequeno | landing-page | landing-page | false | catalog | ERRO |
| 30 | pagina de vendas do meu curso online | landing-page | landing-page | true | landing-page | OK |
| 31 | SISTEMA PRA MERCADINHO | landing-page | landing-page | false | catalog | ERRO |
| 32 | app pra manicure atender em casa | landing-page | **scheduling** | false | scheduling | OK ▲ |
| 33 | quero acompanhar os numero da minha loja | catalog | catalog | **true** | dashboard | ERRO |
| 34 | site pra minha barbearia com fotos dos cortes | landing-page | landing-page | true | landing-page | OK |
| 35 | programa pra hotel | landing-page | landing-page | false | scheduling | ERRO |
| 36 | quero um app pra taxi | landing-page | landing-page | false | landing-page | OK |
| 37 | sistema pra creche | landing-page | landing-page | false | landing-page | OK |
| 38 | aplicativo pra igreja marcar batizado | landing-page | landing-page | false | scheduling | ERRO |
| 39 | loja virtual de roupa usada brecho | landing-page | **catalog** | false | catalog | OK ▲ |
| 40 | quero um app pra minha padaria mostrar os pao | landing-page | **catalog** | false | catalog | OK ▲ |

**Placar: 22/40 antes → 30/40 depois. 8 melhoraram, 0 pioraram, 32 inalterados.**
O ramo faz o que promete neste corpus: quem escreve só o ofício deixa de cair na página de apresentação.

### As 10 frases que ele ainda erra
Nenhuma delas é culpa do ramo — são buracos dos SINAIS (que o ramo não toca) ou ofícios que faltam no catálogo:
- **#10** `"guardar os nome"` — o sinal do catálogo é `" guarda os nome"` e `" guardar nomes"`; a conjugação real
  do brasileiro, `"guardar os nome"`, não casa com nenhum dos dois. Falha por UMA letra.
- **#22** `"imobiliaria"` está no ramo → catalog, mas `"site"` (peso 2) pontua e o ramo nunca roda.
- **#18 academia, #26 food truck, #29 ifood, #31 mercadinho, #35 hotel** — ofícios brasileiros comuns que
  faltam nos 24. Continuam caindo no padrão.
- **#23, #38** — sinal de função ausente ("se inscrever", "marcar batizado").
- **#33** — ver C-05 abaixo.

---

## ONDE O RAMO PIORA O PALPITE (ataque dirigido)

Você perguntou se o ramo pode dar um palpite PIOR que o padrão. **Pode, e dá.** Rodei uma segunda bateria,
desta vez desenhada para o caso "a pessoa nomeia o ofício mas quer uma página de apresentação":

| texto | ANTES (certo) | DEPOIS (errado) |
|---|---|---|
| `quero mostrar minha barbearia na internet` | landing-page ✔ | **scheduling** ✘ |
| `sou dono de uma loja e quero aparecer no google` | landing-page ✔ | **catalog** ✘ |
| `quero contar a historia do meu restaurante` | landing-page ✔ | **catalog** ✘ |
| `nao quero uma loja, quero so um cartao de visita` | landing-page ✔ | **catalog** ✘ |

Quatro regressões reais. Ver achado **C-05**.

---

## ACHADOS

### C-01 — A tela mostra um tipo escolhido e uma frase que diz que não entendeu — HIGH
**Evidência:** `apps/studio-web/src/App.tsx:475` (`props.categoryUnderstood ? t.idea.kindHelp : t.idea.kindHelpUnknown`),
`apps/studio-web/src/App.tsx:406-409` (`updateBrief`), `apps/studio-web/src/i18n/pt-BR.json:118`,
`apps/studio-web/src/categorySuggestion.ts:122`.

O commit acerta o CÓDIGO e erra a TELA. Quem digita `sistema pra barbearia` vê, ao mesmo tempo:

- o seletor **"Tipo de aplicativo"** já marcado em **"Agenda de horários"** (o ramo mexeu nele), e
- logo acima, a frase **"Não deu para entender o tipo pelo seu texto. Escolha abaixo — é o que decide o que o Studio constrói."**

São duas afirmações contraditórias a três centímetros uma da outra, e nenhuma explica a outra. Antes do commit
essa combinação era impossível: `understood=false` sempre vinha acompanhada do padrão neutro `landing-page`,
então não havia nada estranho para a pessoa notar. O commit criou o estado "escolhi pelo ramo" e não deu a ele
NENHUMA palavra na interface — a pessoa recebe o efeito sem a explicação.

**Impacto para quem não programa:** a pessoa lê "não entendi, escolha abaixo", olha o seletor, vê um valor que ela
não escolheu, e não tem como saber se aquilo é (a) o padrão da tela, (b) um palpite, ou (c) algo que ela clicou sem
querer. E a categoria mostrada É a que vai para o servidor (`App.tsx:209`, `category` no corpo do POST): um ramo
errado decide silenciosamente o que será construído, embaixo de uma frase que diz que o Studio não entendeu nada.
A frase pede "escolha abaixo" e a pessoa costuma obedecer a metade disso: já está escolhido, então ela segue.

**Correção sugerida:** o palpite precisa de TRÊS estados na tela, não dois. Trocar o booleano `categoryUnderstood`
por `'texto' | 'ramo' | 'nada'` e acrescentar um terceiro texto ao catálogo, por exemplo:
`kindHelpTrade: "Não deu para entender pelo seu texto o que o aplicativo faz. Como você falou em «barbearia»,
começamos por «Agenda de horários» — troque aqui se não for isso."` Nomear o ofício reconhecido e o motivo é o que
transforma um valor misterioso em um palpite corrigível.

### C-02 — Sobraram quatro botões de rede sem estado de ocupado no fluxo principal — HIGH
**Evidência:** `apps/studio-web/src/App.tsx:435` (parar prévia, `DELETE /previews/*`),
`apps/studio-web/src/App.tsx:504` (**"Ver meu protótipo"** → `POST /previews`, e **"Tentar de novo"** → `generate()`),
`apps/studio-web/src/RunReport.tsx:245` (**"Confirmar"** do voltar-ao-ponto → `POST /undo`) e
`RunReport.tsx:253` (**"Recomeçar a criação"** → `generate()`).

A mensagem do commit afirma: *"Nenhum botão do fluxo principal manda pedido sem avisar."* **Isto é falso**, e eu provei
com o produto rodando. Escrevi um Playwright que percorre o fluxo até o protótipo verificado, atrasa `POST /previews`
em 2 s e clica DUAS vezes em "Ver meu protótipo":

```
POSTS DE PREVIA APOS DOIS CLIQUES: 2      (esperado: 1)
aria-busy depois do primeiro clique: null
botão continua habilitado, com o mesmo texto
```

Varri os 51 `<button>` de `apps/studio-web/src/**`. A maioria é local (sugestões, cartões de estilo, menu, abrir/fechar)
ou já se protege com `disabled={busy}` (Hub, EmergencyStop, TeamPanel, PendingApprovals, Conversation, AssistantEntry).
Os cinco acima são os que fazem chamada de rede sem nenhum sinal — e quatro deles estão no caminho
Ideia → Perguntas → Plano → Criação → **Verificação/Prévia/Voltar**, exatamente o "fluxo principal" da frase.

**Impacto para quem não programa:** "Ver meu protótipo" é o clique mais ansioso do produto inteiro — é o momento em
que a pessoa vai finalmente VER o que pediu, depois de minutos de espera. Nada muda na tela; ela clica de novo; o
Studio sobe duas prévias. Pior é `RunReport.tsx:245`: é o botão que DESFAZ trabalho. Dois cliques em "Confirmar"
mandam dois `POST /undo`.

**Correção sugerida:** os cinco viram `PendingButton`, com gerúndio próprio no catálogo
("Abrindo o protótipo…", "Fechando a prévia…", "Voltando…", "Recomeçando…"). É a mesma transformação de uma linha
que o commit já fez três vezes; o commit parou nas instâncias que o auditor anterior nomeou, e a mensagem generalizou
o resultado além do que foi feito. C-N6 continua aberto como CLASSE.

### C-03 — Os três botões corrigidos não têm nenhum teste — HIGH
**Evidência:** `grep` por `"recomende para mim"`, `"isso é necessário"`, `"retire esses dados"`,
`"Buscando uma recomendação…"`, `"Confirmando…"` e `"Retirando os dados…"` em todo o repositório retorna
**apenas** `apps/studio-web/src/i18n/pt-BR.json:156-162`. Nenhum teste, unitário ou e2e, toca esses botões.
`apps/studio-web/tests/pending.spec.ts:18` cobre só o "Continuar" da tela da ideia.

**Impacto para quem não programa:** o defeito volta na próxima refatoração e ninguém percebe até um usuário criar
dois projetos ou responder duas vezes. Um conserto sem teste é um conserto emprestado. Ver falsificação 1.

**Correção sugerida:** acrescentar ao `pending.spec.ts` o teste que eu escrevi (abaixo, em "O QUE EU FALSIFIQUEI"),
parametrizado sobre os três rótulos. Ele passa hoje e reprova se alguém desfizer a mudança.

### C-04 — Ao ficar ocupado, o botão perde o foco e o leitor de tela não anuncia nada — MEDIUM
**Evidência:** `apps/studio-web/src/PendingButton.tsx:21-30`. Medido no navegador com Playwright:

```
FOCO APOS APERTAR ENTER: BODY:InícioConversar com o DZ23Integrações…
REGIOES VIVAS: ["status=Não foi possível ler o estado da parada", "polite=Você está sem internet…", "polite=Mostrando a tela salva…"]
```

O `aria-busy="true"` e o rótulo em gerúndio EXISTEM (o commit entregou isso), mas o botão fica `disabled` no mesmo
instante — e elemento desabilitado perde o foco. O foco cai no `<body>`, o leitor de tela não anuncia mudança de nome
de um elemento que ninguém está focando, e nenhuma das três regiões vivas da página fala do envio. Quem usa teclado
perde o lugar e recomeça o Tab do topo do documento.

Isto vale para TODOS os `PendingButton`, não só os três novos — mas a mensagem do commit vende `aria-busy` como
"conta a mesma coisa para quem ouve a tela", e na prática não conta.

**Impacto para quem não programa:** a pessoa cega aperta "Não sei — recomende para mim", ouve silêncio absoluto,
perde a posição no documento, e não tem como saber se o Studio ouviu.

**Correção sugerida:** no `PendingButton`, ou (a) manter o botão habilitado e bloquear no `onClick` por `pending`
(a guarda já existe na linha 26), preservando o foco e deixando o leitor anunciar o nome novo; ou (b) acrescentar
um `<span role="status" className="sr-only">` no próprio componente que recebe o `busyLabel`. (a) é a menor mudança
e resolve foco e anúncio de uma vez.

### C-05 — O ramo tira o palpite certo de quem nomeia o ofício e quer uma página — MEDIUM
**Evidência:** `apps/studio-web/src/categorySuggestion.ts:122`; `categorySignals.pt-BR.json:574` (`"loja"` → catalog).
Quatro regressões medidas (tabela acima). O caso `"loja"` é o mais perigoso porque é o substantivo mais genérico
da lista: `"sou dono de uma loja e quero aparecer no google"` era landing-page e virou **catalog**.

O desenho tem três fraquezas somadas:
1. o ramo dispara sempre que a pontuação de função é ZERO, e "quero aparecer no google" / "contar a historia" /
   "cartao de visita" são intenções de apresentação que simplesmente não estão no catálogo de sinais;
2. o ramo ignora negação: `"nao quero uma loja"` vira catalog;
3. **a ordem decide o empate, não a especificidade**: `"loja de pecas e oficina mecanica"` → catalog, porque
   `"loja"` está na posição 20 do JSON e `"oficina"` na 21. Trocar a ordem do arquivo troca a resposta da pessoa.

**Impacto para quem não programa:** o dono da loja que só queria um cartão de visita na internet recebe um catálogo
de produtos — e recebe embaixo da frase "não entendi seu texto" (C-01), sem saber por que aquilo foi escolhido.
Ele ganha um app que precisa de fotos e preços de tudo que vende.

**Correção sugerida:** três medidas pequenas. (1) fortalecer os sinais de `landing-page` com o vocabulário real de
apresentação (`"aparecer no google"`, `"cartao de visita"`, `"contar a historia"`, `"mostrar meu"`, `"na internet"`),
o que faz o ramo nem rodar nesses casos; (2) tirar `"loja"` da lista de ramos, ou apontá-la para `landing-page`
(o padrão), já que sozinha não diz nada sobre a FUNÇÃO — `"loja virtual"`, `"vender online"` e `"brecho"` continuam
mandando para catalog pelos sinais; (3) casar o ramo MAIS LONGO em vez do primeiro da lista, para que a ordem do
arquivo pare de decidir.

### C-06 — Os 24 ofícios cobrem só metade das categorias — MEDIUM
**Evidência:** `apps/studio-web/src/i18n/categorySignals.pt-BR.json:496-592`. Distribuição real:
12 ramos → `scheduling`, 11 → `catalog`, 1 → `crud-panel`, e **zero** → `form-database`, `dashboard`,
`saas-authenticated` ou `landing-page`. Faltam ofícios muito comuns no Brasil: academia, hotel/pousada,
mercadinho, escola/creche, food truck, contador, advogado, transportadora, igreja.

**Impacto para quem não programa:** quem tem uma academia continua recebendo o padrão errado, e a lista favorece
quem marca hora e quem vende produto — um viés que não é declarado em lugar nenhum.

**Correção sugerida:** completar a lista, e explicitar no cabeçalho do JSON que ramo sem entrada é intencionalmente
`landing-page`. Note que isto é ADITIVO e barato — mas só depois de resolver C-05, senão amplia as regressões.

### C-07 — `journey.spec.ts` falhou uma vez na suíte completa e passa isolado — LOW
**Evidência:** `apps/studio-web/tests/journey.spec.ts:142`, na primeira das três execuções completas que fiz
(`1 failed / 61 passed`). Rodado isolado: 4/4 passa. Nas duas execuções completas seguintes: 62 passa / 5 pulados,
exatamente como o commit declara. É intermitência, não regressão deste commit — mas um teste que falha 1 em 3 no
botão "Responder e continuar" ensina a equipe a reexecutar em vez de investigar.

**Correção sugerida:** investigar como flake conhecido, com o `trace.zip` que o Playwright já guardou.

### C-08 — `PendingButton` sem `type="button"` — LOW
**Evidência:** `apps/studio-web/src/PendingButton.tsx:21`. Hoje é inofensivo (nenhum `PendingButton` está dentro de
`<form>` — conferido em `App.tsx` e `PlanEditor.tsx`), mas o padrão do HTML é `type="submit"`: o primeiro
`PendingButton` colocado dentro de um formulário vai submetê-lo e recarregar a página.

**Correção sugerida:** `type="button"` fixo no componente.

### C-09 — FALSO-POSITIVO que eu levantei e descartei
Suspeitei que o casamento por prefixo do ramo (`text.includes(\` ${trade}\`)`, sem limite à direita) produzisse
falsos positivos do tipo `"sou lojista"` → catalog. Medi: `"sou lojista"` → **landing-page**, correto
(`lojista` não contém ` loja`). O casamento por prefixo é, aqui, um acerto — pega `"lojas"`, `"clinicas"`,
`"padarias"` de graça. **Não é um achado.**

---

## O QUE EU FALSIFIQUEI

Quatro mutações, todas restauradas com `git checkout --`.

**1. Desfazer um dos três botões** — troquei o `PendingButton` do "Não sei — recomende para mim"
(`App.tsx:501`) de volta por um `<button>` cru com `onClick={() => void submit(true)}`, `pnpm build` na raiz e rodei tudo.
**Resultado: NADA reprovou.** 344 testes unitários passaram, 62 e2e passaram nos quatro tamanhos, o axe passou.
Só o teste que eu mesmo escrevi (que atrasa `POST /intake/answer` em 1,5 s e clica duas vezes) reprovou.
**Conclusão: a correção dos três botões não tem rede de proteção nenhuma** → achado C-03.

**2. Fazer o ramo ligar `understood`** — troquei `understood: false` por `understood: true` em
`categorySuggestion.ts:122`. **Resultado: 2 testes reprovaram** em `categorySuggestion.spec.ts:103` e no teste do ramo
que o próprio commit acrescentou. **A promessa mais importante do commit está de fato guardada por teste.** ✔

**3. Apontar um ramo para categoria inexistente** — troquei `["barbearia","scheduling"]` por
`["barbearia","agenda-de-horarios"]`. **Resultado: 2 arquivos de teste falharam já no import**, com
`CATEGORY_TRADE_UNKNOWN`. A guarda de carga que o commit descreve funciona de verdade. ✔

**4. Escrever os testes que faltavam** — três Playwright temporários (removidos no fim):
- "Não sei — recomende para mim" com resposta atrasada + clique duplo → **1 POST**. Passa. ✔
- "Responder e continuar" com resposta atrasada + clique duplo → **1 POST**. Passa. ✔
- "Ver meu protótipo" com resposta atrasada + clique duplo → **2 POSTs**, `aria-busy=null`, botão habilitado.
  **Reprova** → achado C-02.

**Estado final:** `git status --porcelain` limpo (só `?? audit/AUDITOR_A_RLS_HUB.md`, de outro auditor);
`pnpm build` refeito a partir da árvore intacta; suíte final **62 e2e passaram / 5 pulados**, unitários 344/344.
Nenhum commit, push, PR ou deploy. Nada tocado em `third_party/`. Nada apagado.
