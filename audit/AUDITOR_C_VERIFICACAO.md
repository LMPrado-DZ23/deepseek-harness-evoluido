# AUDITOR C — Verificação das correções (2ª passada) — DZ23 STUDIO

Segunda passada sobre `audit/AUDITOR_C_PRODUTO_UX.md`, feita em `/home/claude/integ`,
usando o produto no navegador com os olhos de quem não programa — e não só lendo o
diff de `98d2650..HEAD`.

## O que foi realmente executado

| comando | resultado |
| --- | --- |
| `npx vitest run` (apps/studio-web) | **38 arquivos, 340 testes, todos passaram** (13,6 s) — eram 322 |
| `npx playwright test --project=mesa` | 29 passaram, 3 pulados (58,8 s) |
| `npx playwright test --project=tablet --project=celular` | 22 passaram (1,1 min) |
| `npx playwright test --project=faixa-estreita` | 10 passaram, 2 pulados (35,4 s) |
| `npx playwright test --list` | **66 testes em 9 arquivos, 4 tamanhos** |
| `npx vite build` (apps/studio-web) | ok, 3,67 s (mesmo hash do `dist` já presente) |
| `pnpm gate:requirements-ledger` | `PASS requisitos=156 achados=0` |
| **falsificação** de `presentation.spec.ts` (mutei `TRUTH_BY_STATE`) | o teste **reprovou** — a guarda de C-1 é real |
| **falsificação** de `overflow.spec.ts` (mutei `.canvas` para `minmax(480px…)` + build) | o teste **reprovou** — a guarda de M-4 é real |

Testes próprios escritos para esta passada (em `audit/verificacao/`, únicos arquivos criados):
`palpite.vitest.ts` e `queda.vitest.ts` (40 textos meus no `suggestCategory`),
`recarga.spec.ts` (recarrego em cada etapa, no navegador),
`escuro.spec.ts` / `escuro2.spec.ts` (axe no modo escuro nas telas que o e2e do produto **não** varre).
Nada em `third_party/deepseek-harness` foi tocado; `git status` volta limpo fora de `audit/verificacao/`.

---

## Veredito por item

### C-1 — "Protótipo verificado" só com verificação — **CORRIGIDO**

`apps/studio-web/src/presentation.ts:31-40`: a etapa deixou de decidir a frase. Existe uma
tabela `TRUTH_BY_STATE` **exaustiva** (`Record<ProjectUiState, PermanentTruthKind>`), em que
`TESTS_FAILED` e `CANCELLED` valem `'unverified'`, `TESTS_OK` vale `'creation'` e só
`VERIFIED_PROTOTYPE` vale `'verified'`. Um estado novo no tipo não compila até alguém dizer o
que ele afirma. A frase nova existe: `i18n/pt-BR.json` `truth.unverified` = *"Este protótipo não
foi verificado. Ele continua no seu computador e não está publicado."*

O teste `presentation.spec.ts:20-35` afirma os **doze** estados (não uma amostra) e ainda
proíbe a palavra "verificado" dentro da frase de não-verificado. Falsifiquei: troquei
`TESTS_FAILED`/`CANCELLED` para `'verified'` e o teste reprovou; restaurei.

### C-2 — O Studio entende o texto escrito pela pessoa — **PARCIAL**

O mecanismo existe e funciona. `categorySuggestion.ts:suggestCategory` é determinístico e local
(não sai do computador), o vocabulário está em `i18n/categorySignals.pt-BR.json`, e a carga
**explode** se uma categoria ficar sem sinais (`CATEGORY_SIGNALS_MISSING`). A tela mostra o
tipo e deixa corrigir (`App.tsx:462`, `t.idea.kindTitle` "O que vamos criar" + `select`), e a
correção **desliga** o palpite (`categoryChosenByPerson`, `App.tsx:386-396`). A sugestão pronta
**não apaga mais** o texto digitado: `chooseSuggestion` só preenche `if (brief.trim() === '')`
(`App.tsx:380`). Verifiquei no navegador: digitei *"quero uma agenda para minha clinica marcar
consultas dos pacientes"* e o seletor já estava em `scheduling` antes de eu clicar em nada
(`audit/verificacao/recarga.spec.ts`).

**O que falta — onde ele erra.** Rodei 42 textos meus (`audit/verificacao/palpite.txt`,
`queda.txt`).

*Em 22 pedidos escritos por extenso, acertou 17 e errou 5* — e os 5 erros são todos a **mesma
queda**, para `landing-page`:

| texto meu | devolveu | devia |
| --- | --- | --- |
| "salao de beleza, cliente escolhe dia e hora com a manicure" | landing-page | scheduling ("hora" não é sinal; só "horario") |
| "quero q as pessoa marque hora comigo pelo celular" | landing-page | scheduling |
| "sistema pra barbearia" | landing-page | scheduling |
| "controle de ordens de servico da oficina, mexer nos dados" | landing-page | crud-panel |
| "saber quanto entrou e quanto saiu por semana" | landing-page | dashboard |

*Em 20 textos curtos e mal escritos, **19 pontuaram ZERO** e caíram no padrão `landing-page`*:
"AJENDA PRA MINHA CLINICA" (um erro de digitação basta), "app de delivery", "loja virtual com
carrinho e pagamento", "preciso controlar quem me deve", "sistema de ponto dos funcionarios",
"quero um sistema para minha clinica", "um app pra minha loja". E um erro que **troca o gerador
por outro**, não só cai no padrão: *"quero um lugar pros meus pacientes preencherem a ficha
antes da consulta"* → `scheduling` (é `form-database`; "consulta" pesa 2 e "ficha" não é sinal).

**Por que isso ainda machuca:** o palpite não sabe dizer "não sei". Pontuação zero devolve
`landing-page` calada, e a tela por cima afirma **"Entendemos isto pelo seu texto"**
(`i18n/pt-BR.json` `idea.kindHelp`). Para 19 dos meus 20 textos curtos, essa frase é falsa: o
Studio não entendeu nada, escolheu o padrão, e disse à pessoa que entendeu. Ver "achados novos".

### C-3 — O projeto sobrevive à recarga — **PARCIAL, e com um beco sem saída novo**

O mecanismo existe: `App.tsx:551-581` (`projectAddress` / `savedProjectOf` / `rememberProject`),
o `?projeto=` entra no endereço com `history.replaceState`, e `App.tsx:120-132` reidrata no
carregamento. Confirmei no navegador, etapa por etapa (`audit/verificacao/recarga.spec.ts`):

| etapa | o que sobrevive à recarga | o que se perde |
| --- | --- | --- |
| ideia escrita (sem projeto ainda) | nada | **o texto inteiro** e a categoria; o contador volta a "0 de 1000" |
| perguntas (DRAFT) | nada — o `?projeto=` é **removido** e a tela volta à ideia | as respostas já dadas e o texto |
| plano proposto | **tudo**: o plano, as partes, as edições, os botões | — |
| plano aprovado | **tudo**: "Iniciar criação" continua lá | — |
| **criação terminada** | o `?projeto=` fica, mas **o painel esquerdo fica VAZIO** | resultado, critérios, relato, pontos seguros, "Ver meu protótipo" |

A restauração parcial nas perguntas é deliberada e está documentada (`App.tsx:115-118`) —
é defensável. O caso da criação terminada **não é**: virou um beco sem saída novo, descrito
nos achados novos (N-1). E "Meus projetos" continua `href: null` (`navigation.ts:38`), então
o endereço é a única memória que existe.

### H-1 — Limite de relógio e frase honesta — **CORRIGIDO**

`App.tsx:273-322`: o limite virou `Date.now() + 30 * 60_000` (relógio, não voltas), e uma
leitura que falha não encerra mais o acompanhamento — tolera 20 falhas seguidas com 1 s entre
elas (`consecutiveFailures`). Ao esgotar, a frase é `t.verification.followLost` = *"Esta tela
parou de acompanhar a criação. Ela pode continuar no seu computador — atualize a página para
ver em que ponto está."* — que é a verdade, e não mais "uma verificação encontrou um problema".
**Ressalva grave:** a frase manda atualizar a página, e é exatamente aí que se cai em N-1.

### H-2 — Teto de gasto com frase própria — **CORRIGIDO**

`BUDGET_EXCEEDED` entrou em `PipelineResultState` (`presentation.ts:110`), em `ResultMessages`,
no encadeamento de `resultSentence` (`presentation.ts:141`) e na tradução do estado da execução
(`App.tsx:299-303`). A frase (`verification.budgetExceeded`) diz o que acabou, **nega o mal-
entendido** ("Não é um problema no seu aplicativo") e dá três próximos passos.

### H-3 — Conferências em português com o identificador ao lado — **CORRIGIDO**

Vi na tela, no e2e (`audit/verificacao/recarga.spec.ts`, etapa E): *"O aplicativo está em
português do Brasil: Passou `language=pt-BR`"*, *"A página Início existe: Passou `page:Início`"*,
*"A seção Serviços aparece na página: Passou"*. `App.tsx:490` renderiza `check.title ?? check.label`
e só põe o `label` cru num `<span class="check-id"><code>` quando ele difere do título.
`journey.spec.ts:229` cristaliza a frase nova em vez do despejo antigo.

### H-4 — Motivo da rota traduzido em efeito + próximo passo — **CORRIGIDO**

O catálogo de operação parou de vazar. `presentation.ts:157-170` (`routeReasonNotice`) traduz o
**código** (`HALF_OPEN`, `ALL_OPEN`, `BUDGET_BLOCKED`…) por `t.privacy.reasons`, e **cala** quando
não há tradução, em vez de despejar o texto interno. Os 13 códigos de `RouteReasonCode`
(`plugins/route-health/src/service.ts:100-103`) têm os 13 correspondentes em `pt-BR.json`.
Exemplo: `HALF_OPEN` virou *"O serviço externo tinha falhado e está sendo testado de novo agora.
Se ele responder, a criação segue normalmente."* O teste `presentation.spec.ts:88-110` exige
frase > 30 caracteres e **proíbe** "circuito", "meia-abertura", "escopo", "rota paga",
"OmniRoute", "DeepSeek". O identificador cru também saiu do rótulo do perfil (`App.tsx:46-50`);
ele só permanece na frase de privacidade, onde nomear a rota é a honestidade.

### H-5 — Erro nunca mostra código solto — **CORRIGIDO**

`pwa/apiFailure.ts:66-72` (`machineCode`) reconhece `^HTTP \d{3}$`, `CAIXA_ALTA_COM_UNDERSCORE`
e qualquer "frase" de uma palavra só, e troca por `offline.lastResortWithCode` = *"Não foi
possível concluir agora. Nada foi alterado nesta tela. Tente de novo em alguns instantes; se
continuar assim, anote este código para pedir ajuda: {codigo}"*. Uma frase de verdade vinda do
servidor continua valendo (é mais específica). O fallback `Atenção` sozinho também é filtrado
(`apiFailureText` testa o próprio fallback).

### H-6 — Ajuda em /studio/ajuda — **CORRIGIDO**

`src/help/HelpScreen.tsx` + `i18n/help.pt-BR.json`: como funciona do começo ao fim em 5 passos,
glossário de 15 termos (Protótipo, Prévia local, **Verificado**, **Não verificado**, Ponto
seguro, Ambiente isolado, Perfil de privacidade, IA local, Rota externa, Limite de gasto, Chave
de acesso, Integração, Segredo no cofre…), privacidade e "e se der errado". Ligada em
`Navigation.tsx:45`, e o e2e abre pela navegação (`tests/help.spec.ts:12`) e passa no axe nos
quatro tamanhos (`accessibility.spec.ts:73`). *Ressalva pequena:* na barra ela é só um ícone "?"
com `aria-label`; quem lê a lista de texto da barra não vê a palavra "Ajuda".

### H-7 — Botão ocupado — **PARCIAL**

`PendingButton.tsx` faz o certo: `disabled` + `aria-busy` + texto no gerúndio + guarda contra o
segundo clique, e `tests/pending.spec.ts:18` prova no navegador ("o botão fica ocupado e o clique
duplo não passa"). Ele está em **todos** os botões do caminho principal (Continuar, Responder e
continuar, Montar meu plano, Aprovar este plano, Enviar pedido de mudança, Iniciar criação).

**O que falta:** dentro do editor do plano, cinco botões que **fazem chamada de rede** continuam
sendo `<button>` cru, sem `disabled`, sem `aria-busy`: `PlanEditor.tsx:65` ("Guardar minha
alteração"), `:75` ("Tirar esta parte"), `:77` ("Subir"), `:79` ("Descer"). Apertar "Subir" duas
vezes rápido manda duas reordenações.

### H-8 — Metade verificada do e2e religada — **CORRIGIDO**

`journey.spec.ts:75`: `const VERIFIED_JOURNEY_REACHABLE = true`, e o comentário foi reescrito
dizendo que o diagnóstico antigo estava errado — quem não devolvia `facts` era o servidor de
teste. `tests/server.ts:208` agora devolve `attestation` com digest/política/escopo. Confirmei
rodando: `[mesa] journey.spec.ts:77 › percorre as cinco etapas … ✓ (11,0 s)`, e o e2e chega em
*"As verificações declaradas passaram neste computador."*, na prévia, na notificação e no botão
"Ver meu protótipo". A varredura axe que era código morto virou o arquivo
`tests/accessibility.spec.ts` inteiro, que roda nos 4 tamanhos.

### H-9 — "O que foi recusado" em português — **CORRIGIDO**

`RunReport.tsx:268-275` (`findingSentence`) traduz `SECRET_PATTERN` e `PII_PATTERN` em frase, com
o nome do arquivo; `RunReport.tsx:107` mostra a frase e `:109` guarda `caminho:CÓDIGO` num
`<details>` com `<code>`. O mesmo tratamento chegou a "O que foi pedido para corrigir"
(`:94-101`: frase + ajuda, e o diagnóstico cru dentro de `<details><pre>`).

### M-1 — axe no fluxo inteiro, 4 tamanhos, modo escuro — **PARCIAL**

O que melhorou é grande: `tests/accessibility.spec.ts` varre **sete** estados do fluxo (ideia
vazia, ideia preenchida, perguntas, plano, criação, verificação, relato) e a ajuda, e roda em
`mesa`, `tablet` (800px), `celular` (Pixel 5) e o novo `faixa-estreita` (900px). 66 testes no total.

**O que falta:** o modo escuro só varre **ideia, perguntas, plano e ajuda**
(`accessibility.spec.ts:117-152`) — para exatamente antes da tela de verificação. Varri o resto
eu mesmo e ele está quebrado: ver **N-2**, que é a regressão mais séria desta passada.

### M-2 — Vocabulário de máquina fora dos catálogos da pessoa — **PARCIAL**

Limpou onde dói mais: `team.pt-BR.json` trocou *tokens* → **"unidades de uso"**, *commit* →
**"versão"**, *bytes* → **"caracteres"**; `hub.pt-BR.json` trocou *passkey* → **"chave de
acesso"**; a nota de arquitetura sobre o Harness saiu de `assistant.pt-BR.json` e
`openInHarness` virou *"Abrir a conversa completa"*.

**O que falta:** não existe portão. `scripts/check-i18n.mjs` só proíbe a palavra "pronto"; nada
impede a próxima reincidência. E a palavra continua em catálogos que **chegam à tela**:
`plugins/identity/i18n/pt-BR.json:55` *"A interface do **Harness** ainda não está disponível."*,
`plugins/agent-team/i18n/pt-BR.json:21` *"…enquanto o registro do **Harness** ainda informa
trabalho ativo."*, `plugins/agents/i18n/pt-BR.json:4` *"O Harness não preservou o **cwd**
isolado…"* e `:9` *"Confirme com sua **passkey**…"* (o Studio já diz "chave de acesso" em outro
lugar — a mesma coisa com dois nomes), `plugins/studio-web/i18n/pt-BR.json:31`. Some a isso
**N-3** (`health`, `financial`, `minors` em inglês na primeira pergunta do produto).

### M-3 — Menu "Trabalho em equipe" — **CORRIGIDO**

`navigation.ts:40-46`: o item usa `team.navLabel`, que virou *"Trabalho em equipe"*, com o
comentário explicando que o nome é o da tela. A chave morta `nav.progress` sumiu de
`i18n/pt-BR.json` (L-2 também corrigido). Vi na barra, no navegador: *Início · Conversar com o
DZ23 · Integrações · Meus projetos (em breve) · Trabalho em equipe · Ver resultado (em breve)*.

### M-4 — Faixa de 900px — **CORRIGIDO**

`styles.css`: `.canvas` virou `grid-template-columns:minmax(0,1.25fr) minmax(0,.75fr)`, e existe
o projeto `faixa-estreita` (900×800) em `playwright.config.ts:31` rodando `overflow.spec.ts`,
que mede `documentElement.scrollWidth <= innerWidth` na ideia, nas perguntas e na ajuda.
Falsifiquei: devolvi `minmax(480px,…) minmax(360px,…)`, rodei `vite build`, e o teste **reprovou**
("681px de conteúdo…"); restaurei e reconstruí.

### M-5 — Modo escuro no produto todo — **NÃO CORRIGIDO** (e piorou; ver N-2)

`styles.css:206-242` acrescentou um bloco escuro global — `:root`, `body`, `.workspace`,
`.topbar`, títulos, parágrafos, `.task-card`, `.suggestion`, campos, `.status`, `.error`… O
fluxo principal até o plano ficou bom (o axe passa). Mas a mudança **clareou o texto do produto
inteiro** e só escureceu o fundo de uma lista fechada de superfícies. Todas as superfícies que
ficaram de fora agora exibem **texto branco sobre fundo branco**. Isto é uma regressão, não uma
correção parcial: as mesmas telas eram legíveis antes. Detalhe medido em **N-2**.

### M-6 — Estado do Studio que abre e começa neutro — **CORRIGIDO**

O sino e o boneco decorativos foram removidos (`App.tsx:400-403`, com o comentário dizendo por
quê). O `Status` virou um botão de verdade com `aria-expanded` que abre "O que o Studio está
conferindo" com os três campos em português ("inteligência artificial", "Ambiente isolado de
criação", "Espaço em disco"). O estado inicial deixou de ser `ATTENTION`: começa em
"Verificando…". Provado no navegador em `accessibility.spec.ts:85`, que atrasa `/health` em
1,2 s de propósito — rodou e passou nos 4 tamanhos.

### M-7 — Célula de prova de E-04 — **CORRIGIDO**

`docs/MASTER_REQUIREMENTS_LEDGER.md:67` não cita mais `PlanView`. Agora diz *"teste: PlanEditor
lista partes, descricoes e criterios de aceite (apps/studio-web/src/plan/PlanEditor.spec.tsx); os
arquivos sao declarados como decisao do Studio, nao listados"*, e "a LISTA de arquivos" foi para
a coluna de bloqueio junto com "o que falta".

### M-8 — Cobertura declarada de axe e e2e — **PARCIAL**

O método foi consertado, e bem: `scripts/check-requirements-ledger.mjs:281` passou a exigir que
**todo caminho de arquivo citado exista na árvore** — era exatamente o buraco que deixou
`PlanView` passar. U-03 foi reescrita e agora descreve a varredura que existe.

**O que falta:** a contagem de U-05 está errada de novo, e desta vez a própria célula se
declara conferida: *"Playwright 53 passando e 5 pulados em 4 tamanhos (contagem conferida em
09/09)"*. `npx playwright test --list` devolve **66 testes**; somando os quatro projetos rodados
nesta auditoria dão **61 passando e 5 pulados**. A mesma linha ainda diz "tres projetos (mesa,
tablet 800px, celular Pixel 5)" no meio de uma célula cujo título fala em quatro tamanhos.
O portão continua sem conseguir conferir números — só caminhos.

### M-9 — "critérios conferidos" — **CORRIGIDO**

`RunReport.tsx:287-299` (`criteriaSentence`) conta só `status === 'PASSED'`. Quando tudo passou:
*"12 critérios, todos conferidos"*. Quando não: *"12 critérios (7 conferidos, 3 falharam, 2 não
conferidos automaticamente)"* (`checkpoint.criteriaBreakdown`).

### M-10 — Hub — **PARCIAL**

Corrigido: `smtp.help` virou um passo guiado (*"quem cuida da instalação do Studio cadastra a
senha no servidor e dá um nome a ela. Peça esse nome e escreva abaixo"*), `refHelp` diz *"É um
nome, não a senha"*, `refLabel` virou *"Nome que a senha recebeu no servidor"*, "passkey" virou
"chave de acesso" em `confirm.T3`, e `needsApproval` usa o **rótulo** em vez do código
(`presentation.ts:59` chama `tierLabel`).

**O que falta:** `integrations.help` ainda diz *"o nível de confiança sobe para **T2** e, na
versão estável, ela não pode ser ligada"* — o código cru que o resto do bloco acabou de
traduzir. E o Hub é a tela mais quebrada do modo escuro (N-2).

### M-11 — Selo nos protótipos iniciais — **CORRIGIDO**

`App.tsx:436-444` e `:468-470`: as sugestões viraram uma tabela com um terceiro campo (`early`), e
os três cartões de protótipo inicial ganham `<span class="badge-beta">protótipo inicial</span>`
no próprio botão, na hora da escolha. O parágrafo geral continua embaixo, agora como reforço.
*Ressalva:* nenhum teste afirma o selo — se ele cair, ninguém vê.

---

## Achados novos

### N-1 — CRÍTICO — Recarregar depois que a criação termina apaga o resultado e deixa a tela num beco sem saída

A correção de C-3 guarda o projeto no endereço, mas só restaura `projectId`, `projectState` e
`plan` (`App.tsx:120-132`). `result`, `runReport`, `checkpoints` e `preview` continuam em
`useState` e não são reidratados. E o painel esquerdo (`App.tsx:406-417`) não tem **nenhum** ramo
para os estados finais: `VERIFIED_PROTOTYPE`, `TESTS_FAILED`, `CANCELLED` só apareciam através de
`result !== null`.

Medido no navegador (`audit/verificacao/recarga.spec.ts`, etapa E):

```
URL:      /studio/?projeto=e2e-14
ESQUERDA: "Parada de emergência — Não foi possível ler o estado da parada de emergência."
BOTÕES:   []
DIREITA:  "5. Verificação — Etapa atual
           Protótipo verificado — não está publicado nem disponível para outras pessoas"
```

A pessoa fica com a coluna da direita afirmando **"Protótipo verificado"** e a coluna da
esquerda **vazia**: sem resultado, sem os critérios, sem o relato, sem os pontos seguros e, o
que mais dói, **sem o botão "Ver meu protótipo"**. Não há como abrir o que acabou de ser
verificado, e como o `?projeto=` fica no endereço, toda recarga volta para o mesmo lugar.

Antes da correção, recarregar dava a tela da ideia em branco — ruim, mas com saída. Agora dá uma
tela que não é nem uma coisa nem outra. Isso **piorou**.

Agrava tudo: a frase que o produto escreveu para H-1 —
`verification.followLost`: *"…atualize a página para ver em que ponto está."* — **manda a pessoa
exatamente para dentro deste beco**, e é a frase de quem acabou de esperar meia hora.

*Correção:* reidratar `result`/`runReport`/`checkpoints` do `GET /projects/{id}` na restauração,
ou, no mínimo, mostrar um ramo para os estados finais com um botão "reconsultar".
*Como verificar:* e2e que chega em `VERIFIED_PROTOTYPE`, dá `page.reload()` e afirma que
"Ver meu protótipo" continua na tela. Hoje reprova.

### N-2 — CRÍTICO — O modo escuro deixou o Hub, o painel de equipe e a própria tela de verificação com texto branco sobre fundo branco

Varri com axe as telas que `accessibility.spec.ts` **não** cobre no escuro
(`audit/verificacao/escuro.spec.ts`). Amostra do que ele mediu:

| onde | contraste | cores |
| --- | --- | --- |
| Hub — `<h2>E-mail do aplicativo</h2>` | **1,12:1** | `#eef2f9` sobre `#ffffff` |
| Hub — `<label>Nome que a senha recebeu no servidor</label>` | **1,5:1** | `#c9d3e6` sobre `#ffffff` |
| Hub — `<input id="hub-smtp-ref">` (o que a pessoa digita) | **1,12:1** | `#eef2f9` sobre `#ffffff` |
| Hub — busca, filtros, "Integrações", "Baixar o protótipo", "Histórico" | 1,12–2,04:1 | idem |
| Verificação — `<p class="truth">Protótipo verificado…</p>` | **1,91:1** | `#aab6cd` sobre `#f4f8ff` |
| Detalhes técnicos — `<code>VERIFIED_PROTOTYPE</code>` | **1,14:1** | `#dce4f2` sobre `#eef3fb` |
| Relato — `<code>src/GeneratedApp.tsx</code>` | **1,15:1** | `#0b1739` sobre `#1b2540` (escuro sobre escuro) |
| Painel de equipe — `.team-intro`, `.team-moment` | 2,41:1 | `#4b5563` sobre `#0f1523` |
| Hub — `.webmcp-state` | 1,78:1 | `#3d4757` sobre `#151d30` |

São **35 violações** de `color-contrast`, nenhuma delas visível para a suíte, porque o teste
escuro do produto para no plano. O Hub inteiro é ilegível em modo escuro — e o Hub é onde se liga
o e-mail, que é a coisa mais banal que alguém vai querer. A frase permanente
**"Protótipo verificado"** também está a 1,91:1: a única afirmação forte da tela é uma das que
somem.

Causa: `styles.css:206-242` clareou o texto globalmente (`h1,h2,h3,strong{color:#eef2f9}`,
`p,li,dd,label,legend{color:#c9d3e6}`) e escureceu o fundo de uma **lista fechada** de classes.
Toda superfície fora dessa lista (`.hub-card`, `.hub-*`, `.result-technical`, `.truth` sobre
`#f4f8ff`, `.team-*`) continuou branca com o texto agora branco.

*Correção:* dar ao escuro os mesmos tokens de fundo que o claro tem (ou fazer as superfícies
herdarem), e estender o teste escuro até a verificação, o relato, o Hub e o painel de equipe.

### N-3 — ALTO — A primeira pergunta que a pessoa recebe traz o código em inglês do dado sensível

Escrevi *"quero uma agenda para minha clinica marcar consultas dos pacientes"* e a primeira tela
depois de "Continuar" foi:

> **Sua ideia parece envolver dados sensíveis (health). Você confirma que isso é necessário?**
> [Sim, isso é necessário] [Não, retire esses dados]

`plugins/prompt-to-app/src/appspec.ts:104-107` monta a frase com `kinds.join(', ')`, e `kinds`
são os valores crus do enum (`appspec.ts:5`): `cpf`, **`health`**, **`financial`**, **`minors`**.
Três dos quatro são palavras em inglês, e chegam entre parênteses na **decisão mais delicada do
produto** — a de continuar ou não com dado sensível. Quem não lê inglês responde no escuro.
É precisamente a classe de defeito que M-2 mandou eliminar, e ela sobreviveu porque a limpeza
foi feita catálogo a catálogo, sem portão.

*Correção:* um rótulo em pt-BR por espécie ("dados de saúde", "dados financeiros", "dados de
menores de idade", "CPF") no catálogo, e nunca `join` de enum.

### N-4 — MÉDIO — "Entendemos isto pelo seu texto" é dito também quando nada foi entendido

`suggestCategory` devolve `landing-page` tanto quando os sinais de página apontam para ela quanto
quando **nada pontuou** — as duas saídas são indistinguíveis (`categorySuggestion.ts:75-87`).
A tela por cima afirma `idea.kindHelp`: *"Entendemos isto pelo seu texto."* Medi: **19 de 20**
textos curtos e mal escritos pontuam zero (`audit/verificacao/queda.txt`). Para eles, a tela
afirma um entendimento que não houve e mostra "Página de apresentação" como se fosse leitura da
ideia. O selo honesto que M-11 pôs nos cartões faltou aqui.

*Correção:* `suggestCategory` devolver também a pontuação (ou `null`), e a tela trocar a frase
por *"Não deu para entender pelo seu texto — escolha o tipo abaixo"* quando o palpite for cego.

### N-5 — MÉDIO — O e2e roda contra `dist`, e nada na execução do e2e reconstrói

`tests/server.ts:331` serve `apps/studio-web/dist`, e `playwright.config.ts` (`webServer`) só
sobe o servidor. Descobri isso ao falsificar M-4: mudei `styles.css`, rodei o e2e e ele **passou**
— porque estava medindo o bundle antigo. Só depois de `npx vite build` o teste reprovou.
Ou seja: todas as garantias de tela (axe, contraste, transbordo, botão ocupado, modo escuro)
podem envelhecer em silêncio se alguém rodar o Playwright sem construir antes.
*Correção:* um `build` como pré-passo do `test:e2e`, ou uma guarda que compare a data de `dist`
com a de `src`.

### N-6 — BAIXO — Cinco botões do editor do plano fazem chamada de rede sem estado de ocupado

`PlanEditor.tsx:65,66,74,75,77,79` — "Guardar minha alteração", "Tirar esta parte", "Subir",
"Descer". São `<button>` crus, ao lado de dois `PendingButton` na mesma tela. Dois cliques
rápidos em "Subir" mandam duas reordenações.

### N-7 — BAIXO — "Ajuda" só existe como ícone

`Navigation.tsx:45` põe a ajuda como `<a class="nav-icon">` com `aria-label`, fora da lista de
`studioNavItems()`. Quem varre a barra lendo os nomes (Início, Conversar, Integrações, Meus
projetos, Trabalho em equipe, Ver resultado) não encontra a palavra "Ajuda" em lugar nenhum.

### Regressões — resumo

Duas, ambas efeito colateral de correções desta rodada, ambas em telas que os testes novos não
alcançam: **N-1** (a memória do projeto no endereço criou um estado final sem tela) e **N-2**
(o modo escuro global apagou o texto de todas as superfícies que ficaram fora da lista).
As duas somam: quem recarrega depois da criação, em modo escuro, vê uma tela vazia com uma
frase quase invisível dizendo "Protótipo verificado".

### Coisas que procurei e continuam limpas

- **"Protótipo verificado" com falha ou cancelamento**: não reproduz mais, em teste unitário
  exaustivo nem na tela.
- **A sugestão apagando o texto**: não reproduz (`chooseSuggestion` só preenche se vazio).
- **Código de máquina no `.error`**: `machineCode` cobre `HTTP 5xx`, caixa alta com underscore e
  palavra solta.
- **Alegação de publicação**: `journey.spec.ts:214` continua afirmando zero ocorrências de
  "publicado na internet", e o e2e agora percorre até o fim de verdade.
- **Motivo da rota em jargão de operação**: proibido por teste.
- **Transbordo lateral**: guardado por `overflow.spec.ts` em 900px, falsificado com sucesso.

---

## O que um leigo ainda não consegue fazer

1. **Recuperar o próprio protótipo depois de fechar ou recarregar a página no fim.** O endereço
   guarda o projeto, mas a tela final não sabe se redesenhar: sobra a frase "Protótipo
   verificado" sem nada para abrir (N-1). E "Meus projetos" continua "em breve"
   (`navigation.ts:38`), então não há segunda porta.
2. **Usar o Studio com o celular em modo escuro.** O Hub é literalmente branco sobre branco, e a
   tela de verificação perde a frase permanente (N-2).
3. **Ser entendido escrevendo pouco, ou escrevendo torto.** "sistema pra barbearia",
   "app de delivery", "AJENDA PRA MINHA CLINICA", "preciso controlar quem me deve" — todos viram
   página de apresentação, e a tela diz que entendeu (C-2/N-4). A correção existe (o seletor está
   ali, visível, e funciona), mas ela **depende de a pessoa desconfiar da frase que o produto
   acabou de afirmar**.
4. **Decidir sobre dado sensível sabendo do que se trata.** A pergunta chega com `(health)`
   entre parênteses (N-3).
5. **Ligar o e-mail do aplicativo sozinha.** O texto do Hub agora explica muito bem o que fazer
   ("peça o nome a quem instalou o Studio") — mas a resposta continua sendo *pedir a outra
   pessoa*. Isso é honestidade, não solução.
6. **Ver o consumo em algo que signifique dinheiro ou tempo.** "unidades de uso" é melhor do que
   "tokens" e ainda não é uma unidade que alguém reconheça.
7. **Voltar a um projeto interrompido no meio das perguntas.** Deliberado e documentado, mas o
   efeito para quem usa é o mesmo: recomeçar do zero, inclusive o texto da ideia.

## Placar da 2ª passada

| item | veredito |
| --- | --- |
| C-1, H-1, H-2, H-3, H-4, H-5, H-6, H-8, H-9, M-3, M-4, M-6, M-7, M-9, M-11 | **CORRIGIDO** (15) |
| C-2, C-3, H-7, M-1, M-2, M-8, M-10 | **PARCIAL** (7) |
| M-5 | **NÃO CORRIGIDO** (1) |
| novos | N-1 e N-2 críticos (regressões), N-3 alto, N-4/N-5 médios, N-6/N-7 baixos |

**Antes de mostrar isto a uma pessoa leiga real, conserte N-1 e N-2.** Os dois nasceram nesta
rodada de correções, os dois estão fora do alcance dos testes novos, e os dois terminam na
mesma tela: aquela em que o produto afirma "Protótipo verificado" e não entrega nada.
