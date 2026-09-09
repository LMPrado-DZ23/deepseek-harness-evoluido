# AUDITOR C — Produto / QA / UX — DZ23 STUDIO

Auditoria independente, feita em `/home/claude/integ`, com os olhos de uma pessoa
que **não programa** e quer sair de uma ideia escrita em português para um
aplicativo.

## O que foi realmente executado nesta auditoria

| comando | resultado |
| --- | --- |
| `npx vitest run` em `apps/studio-web` | **35 arquivos, 322 testes, todos passaram** (13,1 s) |
| `npx playwright test` com `DZ23_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome` | **36 passaram, 3 pulados**, 39 no total (55,0 s) |
| `pnpm gate:requirements-ledger` | `REQUIREMENTS_LEDGER=PASS requisitos=156 achados=0 BETA=89 FAILED=4 NOT_CONFIGURED=1 NOT_EXECUTED=4 NOT_PRESENT=33 STABLE=25` |
| `pnpm build` | **NÃO EXECUTADO** nesta auditoria (tempo); nenhum achado abaixo depende dele |

Leitura de código: `apps/studio-web/src/**`, `apps/studio-web/tests/**`,
`plugins/*/i18n/pt-BR.json`, `plugins/prompt-to-app/src/**`,
`plugins/emergency-stop/src/**`, `docs/MASTER_REQUIREMENTS_LEDGER.md`,
`scripts/check-requirements-ledger.mjs`.

Nada em `third_party/deepseek-harness` foi alterado. Nenhum push, PR, deploy ou
remoção foi feito. O único arquivo criado é este.

---

## Achados

### CRITICAL

---

#### C-1 — A tela declara "Protótipo verificado" quando a criação FALHOU, foi CANCELADA, ou ainda está rodando

**Arquivo:** `apps/studio-web/src/presentation.ts:7-20`, renderizado em
`apps/studio-web/src/App.tsx:393`.

```ts
export function currentStepIndex(state: ProjectUiState | null): number {
  ...
  if (state === 'PLAN_APPROVED' || state === 'GENERATING' || state === 'BUILD_OK' || state === 'BUILD_FAILED' || state === 'INTERRUPTED') return 3
  return 4                                    // ← TESTS_FAILED, TESTS_OK e CANCELLED caem aqui
}
export function permanentTruthKind(state: ProjectUiState | null): PermanentTruthKind {
  const step = currentStepIndex(state)
  if (step === 3) return 'creation'
  if (step === 4) return 'verified'           // ← e viram "verified"
  return null
}
```

**O que a pessoa vê:** no painel direito, a frase permanente
`t.truth.verified` = **"Protótipo verificado — não está publicado nem disponível
para outras pessoas"** — ao mesmo tempo em que o painel esquerdo diz
"A criação parou porque uma verificação encontrou um problema" (`TESTS_FAILED`)
ou "A criação foi cancelada." (`CANCELLED`). Em `TESTS_OK` (estado do MEIO da
execução) o esquerdo ainda diz "Criando e conferindo dentro do ambiente
isolado…" (`App.tsx:323`) e o direito já diz "Protótipo verificado".

**Por que atrapalha:** é exatamente a promessa que a política do projeto
proíbe. Duas frases contraditórias na mesma tela, e a mais forte das duas —
"verificado" — é a falsa. Uma pessoa leiga acredita na palavra "verificado" e
não na explicação, e vai baixar/mostrar um protótipo que não passou nos testes.

**Prova de que ninguém testa isso:** `apps/studio-web/src/presentation.spec.ts:16-24`
afirma `permanentTruthKind` para `null`, `DRAFT`, `SPEC_READY`, `PLAN_PROPOSED`,
`GENERATING`, `BUILD_FAILED`, `INTERRUPTED`, `TESTS_OK`, `VERIFIED_PROTOTYPE` —
e **omite exatamente `TESTS_FAILED` e `CANCELLED`**, os dois casos do defeito.
A linha 10 do mesmo arquivo já sabe que eles valem 4.

**Correção sugerida:** `permanentTruthKind` deve devolver `'verified'` somente
para `VERIFIED_PROTOTYPE`; `TESTS_FAILED`/`BUILD_FAILED` devem ter uma terceira
frase própria ("A criação parou — nada foi verificado nem publicado") e
`CANCELLED`/`TESTS_OK` devem devolver `'creation'` ou `null`.

**Como verificar:** acrescentar em `presentation.spec.ts`
`expect(permanentTruthKind('TESTS_FAILED')).not.toBe('verified')` e
`expect(permanentTruthKind('CANCELLED')).not.toBe('verified')` — hoje as duas
reprovam.

---

#### C-2 — Quem escreve a própria ideia sempre recebe uma página de apresentação, qualquer que seja o pedido

**Arquivo:** `apps/studio-web/src/App.tsx:52` e `:308`.

```ts
const [category, setCategory] = useState<Category>('landing-page')
...
function chooseSuggestion(value: string, selected: Category) { setBrief(value); setCategory(selected) }
```

`setCategory` **só** é chamada por `chooseSuggestion`. A categoria vai crua para
o servidor em `App.tsx:160` (`body: JSON.stringify({ ..., category, privacy })`)
e é ela que decide qual gerador roda
(`plugins/prompt-to-app/src/pipeline.ts` usa `project.category`;
`plugins/prompt-to-app/src/intake.ts:47` injeta
`t('prompts.category', { category: conversation.project.category })` no prompt).
Não existe nenhuma inferência de categoria a partir do texto — verificado por
busca em `plugins/prompt-to-app/src` e `apps/studio-web/src`: zero
`classifyCategory`/`inferCategory`/`detectCategory`. As três perguntas do
intake (`plugins/prompt-to-app/i18n/pt-BR.json:2-6`: "Para quem…", "O que a
pessoa deve conseguir fazer…", "Quais informações…") também nunca perguntam o
tipo de aplicativo.

**O que a pessoa vê:** o título convida — "Vamos criar seu aplicativo / Conte
com suas palavras o que você precisa" (`i18n/pt-BR.json` `idea.title`,
`idea.subtitle`). Ela escreve "quero uma agenda para minha clínica marcar
consultas", aperta Continuar, responde três perguntas, aprova um plano — e o
Studio constrói uma **landing page**. Em nenhum momento a tela mostra, nomeia
ou permite corrigir a categoria escolhida.

**Agravante:** clicar numa sugestão para "consertar" a categoria **apaga o texto
que ela escreveu** (`setBrief(value)` em `App.tsx:308`). Não há como ter o texto
próprio e a categoria certa ao mesmo tempo.

**Por que atrapalha:** é o núcleo do produto quebrado. "Recebe uma ideia em
linguagem comum e produz um aplicativo real" só funciona para 7 frases prontas.

**Correção sugerida:** (a) classificar a categoria a partir do texto (o modelo
do intake já é chamado — é uma pergunta a mais no mesmo prompt), (b) mostrar
na tela a categoria escolhida com um seletor de correção em linguagem comum, e
(c) fazer a sugestão preencher a categoria **sem** sobrescrever texto já digitado.

**Como verificar:** teste de unidade sobre `create()` — brief de agenda com
`category` nunca tocada deve produzir `category !== 'landing-page'`; hoje
produz `'landing-page'`.

---

#### C-3 — Recarregar a página ou clicar em qualquer item do menu apaga o projeto da tela, e "Meus projetos" está desligado

**Arquivos:** `apps/studio-web/src/App.tsx:62-79` (todo o estado do projeto é
`useState`, nada em URL/`localStorage`), `apps/studio-web/src/main.tsx:13-16`
(a tela é escolhida **uma vez** no carregamento a partir de
`window.location.pathname`; a navegação são `<a href>` em
`Navigation.tsx:41`, ou seja, recarga completa),
`apps/studio-web/src/navigation.ts:39` e `:44`
(`{ id: 'projects', href: null }`, `{ id: 'result', href: null }`).

Busca confirmada: nenhuma ocorrência de `localStorage`/`sessionStorage`/
`pushState` guarda `projectId` — o único uso de storage no App é o token CSRF
(`api.ts:10`).

**O que a pessoa vê:** ela está na etapa "Criação", quer ver as integrações,
clica em **Integrações** na barra lateral, volta ao Studio — e cai na tela
"Vamos criar seu aplicativo", em branco. O item **Meus projetos** está cinza com
"em breve". O projeto continua existindo no servidor, mas não há caminho de volta
para ele pela interface.

**Por que atrapalha:** perda total de trabalho por um clique normal. Numa criação
que pode durar minutos, isso vai acontecer. E o único recurso possível — a lista
de projetos — é justamente o que está desligado.

**Correção sugerida:** guardar `project_id` na URL (`/studio/projeto/:id`) e
reidratar o estado a partir de `GET /projects/{id}` no carregamento; ou, no
mínimo, ligar "Meus projetos" antes de qualquer outra coisa da lista de "em breve".

**Como verificar:** e2e: chegar em `PLAN_PROPOSED`, `page.reload()`, e afirmar
que o plano ainda está na tela. Hoje volta para a tela da ideia.

---

### HIGH

---

#### H-1 — A tela desiste de acompanhar a criação e chama isso de "falha de verificação"

**Arquivo:** `apps/studio-web/src/App.tsx:223-257`.

```ts
for (let poll = 0; poll < 1_800; poll++) {
  ...
  await new Promise(resolve => setTimeout(resolve, 250))
}
throw new Error(t.verification.failure)
```

1.800 × 250 ms ≈ **7,5 minutos** (mais o tempo de cada round-trip). O pipeline
permite 3 tentativas com timeout de 180 s cada (declarado em E-05 do ledger),
ou seja **até ~9 minutos só de execução**, sem contar `install` e `build`.

**O que a pessoa vê:** depois de ~7,5 min, a frase
`t.verification.failure` = **"A criação parou porque uma verificação encontrou
um problema."** A criação **não parou** e **nenhuma verificação encontrou nada** —
a tela é que desistiu de perguntar. Não há botão de "continuar acompanhando",
e como não há recuperação por recarga (C-3), o trabalho fica invisível.

**Agravante:** `pollProject` roda dentro de `safely(..., 'read')`
(`App.tsx:221`). Uma única falha de rede durante a espera encerra o loop para
sempre e mostra a mensagem de rede — a criação continua no servidor e a pessoa
nunca mais vê o resultado.

**Correção sugerida:** não transformar esgotamento de polling em falha; mostrar
"ainda estamos acompanhando" com botão de reconsultar, e retomar o polling após
erro transitório de leitura em vez de abortar.

**Como verificar:** teste sobre `pollProject` com um servidor que responde
`RUNNING` 1.801 vezes — hoje o resultado apresentado é `failure`.

---

#### H-2 — Estourar o teto de gasto é apresentado como "uma verificação encontrou um problema"

**Arquivos:** `apps/studio-web/src/App.tsx:233-239` e
`apps/studio-web/src/presentation.ts:109-115`.

`BUDGET_EXCEEDED` está na lista de estados terminais (`App.tsx:233`) mas **não
existe** no encadeamento que traduz o estado (`:234-238`): ele cai no último
ramo e vira `TESTS_FAILED` ou `BUILD_FAILED`. `PipelineResultState`
(`presentation.ts:87-88`) nem lista `BUDGET_EXCEEDED`, e `ResultMessages` não
tem frase para ele. Confirmado por busca: **não há nenhuma chave sobre gasto ou
orçamento em `apps/studio-web/src/i18n/*.json`** (o único "teto de gasto" do
produto está em `plugins/route-health/i18n/pt-BR.json:15-16`, que é outra tela).

**O que a pessoa vê:** "A criação parou porque uma verificação encontrou um
problema." Ela vai procurar um defeito no aplicativo dela. O problema é dinheiro
/ tempo de execução, e ela não tem como saber — nem como corrigir.

**Correção sugerida:** acrescentar `BUDGET_EXCEEDED` a `PipelineResultState` e
uma frase própria: o que estourou, quanto, e o que fazer (aumentar o teto,
trocar de perfil de IA, simplificar o plano).

**Como verificar:** `resultSentence('BUDGET_EXCEEDED', t.verification)` — hoje
nem compila com o tipo, e em runtime devolve `failure`.

---

#### H-3 — A lista de "Critérios conferidos" é um despejo de identificadores de máquina

**Arquivo:** `plugins/prompt-to-app/src/acceptance.ts:67-108`, renderizado em
`apps/studio-web/src/App.tsx:373`.

```ts
{ id: 'language', label: `language=${spec.language}`, ... }
{ id: 'document-title', label: 'document-title', ... }
checks.push({ id: `page-${pageIndex}`, label: `page:${page.name}`, ... })
checks.push({ ..., label: `section:${section}`, ... })
checks.push({ ..., label: `entity:${entity.name}`, ... })
checks.push({ ..., label: `field:${...}`, ... })
checks.push({ ..., label: `${crud ? 'crud' : 'fluxo'}:${entity.name}`, ... })
```

**O que a pessoa vê**, na única tela que responde "meu aplicativo faz o que eu
pedi?":

```
Critérios conferidos
  language=pt-BR: Passou
  document-title: Passou
  page:Início: Passou
  section:Serviços: Passou
  entity:Cliente: Passou
  field:nome: Passou
  crud:Cliente: Não verificado automaticamente
```

O próprio e2e cristaliza isso: `journey.spec.ts:226` espera
`page.getByText('page:Início: Passou')`.

**Por que atrapalha:** viola diretamente o requisito C-09 do ledger ("linguagem
comum primeiro, técnico só em Opções avançadas"). Só os critérios que a própria
pessoa escreveu (`criterion-N`, linha 80) recebem rótulo humano; tudo o que o
Studio deduziu vem em inglês, com `:` e `=`. Ela não consegue julgar se o
resultado serve.

**Correção sugerida:** dar a cada `kind` uma frase em pt-BR
("A página **Início** existe", "O cadastro de **Cliente** pode ser criado,
editado e excluído") e deixar `label` cru dentro de "Detalhes técnicos".

**Como verificar:** teste que reprova qualquer `label` de check contendo `:`,
`=` ou palavra em inglês fora de `criterion-*`.

---

#### H-4 — Jargão de circuito, teto de gasto e nome de provedor na PRIMEIRA tela do produto

**Arquivos:** `plugins/route-health/i18n/pt-BR.json:5-19` (motivos), consumido
por `apps/studio-web/src/presentation.ts:129-135` (`routeReasonNotice`) e
exibido em `apps/studio-web/src/App.tsx:366` como
`<p className="privacy-notice">{t.privacy.routeReason} {routeReasonNotice(...)}</p>`.

Frases que chegam **literais** à tela da ideia, precedidas de "Por que esta rota:":

- `"Meia-abertura: uma chamada decide se o circuito fecha ou reabre."`
- `"Circuito aberto em todas as rotas; nenhuma chamada nova enquanto durar a espera."`
- `"OmniRoute falhou antes de produzir conteúdo; usando a rota DeepSeek direta."`
- `"Teto de gasto do escopo estourado; nenhuma rota paga foi acionada."`
- `"Rota desligada neste espaço de trabalho; ela não é escolhida enquanto continuar assim."`

**Por que atrapalha:** "circuito", "meia-abertura", "escopo", "rota paga",
"OmniRoute", "DeepSeek" não significam nada para o público-alvo. Nenhuma dessas
frases dá **próximo passo** — a pessoa lê que algo está aberto/estourado e não
sabe se deve esperar, mudar de perfil, ou desistir.

**Agravante na mesma linha:** `App.tsx:365` cola o identificador cru da rota no
rótulo do perfil — `Equilibrado (ollama-local)`, `Melhor qualidade
(deepseek-official)`.

**Correção sugerida:** traduzir cada motivo para efeito + próximo passo
("O serviço de IA externo está indisponível agora. Você pode esperar alguns
minutos ou escolher o perfil Privado local."), e esconder o identificador da
rota atrás de "Opções avançadas".

**Como verificar:** varredura sobre `route-health/i18n` proibindo
"circuito", "meia-abertura", "escopo", e nomes de provedor em `reasons.*`.

---

#### H-5 — Erros que deixam a pessoa com uma palavra solta ("Atenção") ou com "HTTP 502"

**Arquivos:** `apps/studio-web/src/api.ts:47` e `:49`;
`apps/studio-web/src/App.tsx:154`, `:209`, `:175`;
`apps/studio-web/src/pwa/generation.ts:57`, `:62`.

```ts
// api.ts
if (!response.ok && !(...)) throw new Error(body?.error ?? `HTTP ${response.status}`)
if (body === null) throw new Error(`HTTP ${response.status}`)
```

```ts
// App.tsx:154 — a frase de último recurso de TODAS as ações da tela
catch (cause) { setError(apiFailureText(cause, navigator.onLine, call, t.health.attention)) }
```

`t.health.attention` é literalmente a palavra **`"Atenção"`**
(`i18n/pt-BR.json`, bloco `health`).

**O que a pessoa vê:** em `<p className="error" role="alert">` (App.tsx:332),
um dos dois: **`Atenção`** ou **`HTTP 502`**. Sem causa, sem o que fazer, sem
para onde ir. O mesmo vale para a recusa de criação:
`generation.ts:62` devolve `fallback` (= "Atenção") quando o servidor aceita sem
`run_id`.

**Correção sugerida:** uma frase de último recurso de verdade
("Não foi possível concluir agora. Nada foi alterado. Tente de novo em alguns
instantes; se continuar, anote este código: {codigo}") e nunca mostrar
`HTTP {status}` sozinho.

**Como verificar:** teste que reprova qualquer texto de `.error` com menos de
~20 caracteres ou casando `/^HTTP \d+$/`.

---

#### H-6 — Um produto para leigos sem nenhuma ajuda: "Ajuda" está permanentemente desligada

**Arquivo:** `apps/studio-web/src/Navigation.tsx:44-45`.

```tsx
<button type="button" className="nav-icon-unavailable" disabled aria-label={`${t.nav.help} (${t.nav.soon})`}><CircleHelp/></button>
<button type="button" className="nav-icon-unavailable" disabled aria-label={`${t.nav.settings} (${t.nav.soon})`}><Settings/></button>
```

Somando com `navigation.ts:39,44`, **4 dos 8 destinos da navegação estão
desligados**: Meus projetos, Ver resultado, Ajuda, Configurações.

**O que a pessoa vê:** dois ícones cinzas no rodapé da barra, que não abrem nada.
Não há FAQ, tutorial, glossário, nem "o que é um protótipo?" em lugar nenhum do
aplicativo.

**Por que atrapalha:** o produto usa vocabulário próprio o tempo todo —
"protótipo", "prévia local", "ponto seguro", "ambiente isolado", "perfil de
privacidade", "integridade conferida" — e não oferece um único lugar para
descobrir o que essas palavras querem dizer. Marcar como "em breve" é honesto,
mas não substitui a ajuda.

**Correção sugerida:** uma página estática de ajuda em pt-BR com o glossário
dos termos que a interface já usa, ligada ao ícone existente. É o item de menor
custo e maior efeito da lista.

**Como verificar:** `studioNavItems()` — o item `help` deixa de ter `href: null`.

---

#### H-7 — Nenhum estado de carregamento no fluxo principal: dá para apertar duas vezes e não há sinal de que algo está acontecendo

**Arquivo:** `apps/studio-web/src/App.tsx` inteiro. Busca por
`aria-busy|aria-live|role="status"` devolve **3 ocorrências**, e as três estão
fora do fluxo: o botão de Sair (`:312`), a lista de códigos da prévia (`:330`) e
o contador de caracteres (`:353`).

Nenhum dos botões do caminho Ideia → Perguntas → Plano → Criação
(`Continuar`, `Responder e continuar`, `Montar meu plano`, `Aprovar este plano`,
`Enviar pedido de mudança`, `Iniciar criação`) é desabilitado durante a chamada,
nem tem `aria-busy`, nem troca de texto.

**O que a pessoa vê:** aperta "Aprovar este plano", nada muda por 1-3 segundos,
aperta de novo. Em leitor de tela, silêncio completo.

**Isto já está confessado no ledger** (`docs/MASTER_REQUIREMENTS_LEDGER.md`,
linha U-03): *"Mas App.tsx nao tem NENHUM estado de carregamento: sem aria-busy,
sem botao desabilitado durante a chamada"* — o que faz dele um defeito conhecido
e não corrigido, não um achado novo. Registro aqui pela severidade para o
público-alvo.

**Correção sugerida:** um `pending` por ação, com `disabled` + `aria-busy` +
texto no gerúndio, como já é feito no `signout-button` e no HubPanel
(`HubPanel.tsx:109`, que faz exatamente isso).

**Como verificar:** e2e que atrasa a resposta de `/plan/approve` e afirma que o
botão fica `disabled` — hoje reprova.

---

#### H-8 — O e2e principal desliga a metade de sucesso da jornada com uma justificativa desatualizada

**Arquivo:** `apps/studio-web/tests/journey.spec.ts:60-74` e `:216-222`.

```ts
/**
 * O trecho verificado desta jornada NÃO é alcançável hoje.
 * `plugins/prompt-to-app/src/pipeline.ts:213` lança ACCEPTANCE_ATTESTATION_UNAVAILABLE
 * exatamente quando o ciclo do construtor passa ...
 */
const VERIFIED_JOURNEY_REACHABLE = false
```

**A justificativa não é mais verdadeira.** Em
`plugins/prompt-to-app/src/pipeline.ts:297` o `throw` está dentro de
`if (facts === undefined)` (linha 283) — só dispara quando a sessão do
construtor **não declara** imagem/política/escopo. O ledger confirma em E-05:
*"O ACHADO GRAVE FOI CORRIGIDO: o caminho de SUCESSO nao lanca mais."*

A causa real hoje é o **fixture do próprio teste**:
`apps/studio-web/tests/server.ts:188-198` — o `finish()` do construtor de teste
devolve `{ finalState, exported, cleanupPending, cleaned }` e **nunca**
`attestation`. Ou seja, o teste bloqueia a si mesmo e atribui isso ao produto.

**O que fica sem prova de navegador nenhuma, por causa disso:**
protótipo verificado, a prévia (`iframe`, códigos de acesso, ciclo de admissão),
a notificação de conclusão, o botão "Ver meu protótipo", **e a única varredura
axe de página inteira do repositório** (`journey.spec.ts:285`, depois do
`return` da linha 221 — código morto).

**Por que atrapalha:** a auditoria interna acredita ter cobertura de jornada
completa (o ledger E-01 afirma *"a jornada ... está LIGADA de ponta a ponta"*)
quando o navegador nunca a percorreu até o fim.

**Correção sugerida:** preencher `attestation` no `finish()` do fixture com
fatos determinísticos e virar a bandeira; se a decisão for manter desligado,
corrigir o comentário — ele aponta um arquivo:linha que não existe mais.

**Como verificar:** `grep -n "attestation" apps/studio-web/tests/server.ts` →
zero ocorrências hoje.

---

#### H-9 — "O que foi recusado" mostra códigos crus fora dos Detalhes técnicos

**Arquivos:** `apps/studio-web/src/RunReport.tsx:104` (a lista) com
`plugins/prompt-to-app/src/security.ts:5-6` (a origem).

```ts
if (secret.test(content)) findings.push(`${path}:SECRET_PATTERN`)
if (containsCpf(content)) findings.push(`${path}:PII_PATTERN`)
```

```tsx
<ul>{report.findings.map(finding => <li key={finding}>{finding}</li>)}</ul>
```

**O que a pessoa vê**, sob o título "O que foi recusado" e o texto de apoio
"Os controles de segurança e privacidade recusaram estes itens antes de qualquer
coisa rodar":

```
src/GeneratedApp.tsx:SECRET_PATTERN
content/app.json:PII_PATTERN
```

O mesmo vale para "O que foi pedido para corrigir" (`RunReport.tsx:97`), que
imprime `report.correction` num `<pre>` — o diagnóstico cru do pipeline
(`build: exit 1`, `TEMPLATE_INTEGRITY_FAILED`).

**Por que atrapalha:** o resto do `RunReport` é exemplar (etapas em pt-BR,
técnico atrás de `<details>` fechado, provado no e2e nas linhas 195-206). Estas
duas seções furam a própria regra e são justamente as que aparecem quando algo
deu errado — o pior momento para entregar inglês em caixa alta sem próximo passo.

**Correção sugerida:** traduzir os dois códigos ("Encontramos algo parecido com
uma senha no arquivo X" / "Encontramos um CPF no arquivo X"), com o que fazer, e
mandar `path:CODE` para dentro de um `<details>`.

**Como verificar:** e2e que produz um finding e afirma que `SECRET_PATTERN` está
`toBeHidden()` antes do clique no `<summary>` — o mesmo padrão que a linha 190
já usa para `ACCEPTANCE_ATTESTATION_UNAVAILABLE`.

---

### MEDIUM

---

#### M-1 — Os três tamanhos de axe cobrem 3 telas; as 8 telas do fluxo principal nunca são varridas

**Arquivo:** `apps/studio-web/playwright.config.ts:22-26`.

```ts
{ name: 'mesa',    use: { ...devices['Desktop Chrome'] } },
{ name: 'tablet',  testMatch: /(mobile-nav|team-panel)\.spec\.ts$/u, use: { ...viewport: { width: 800, height: 1180 } } },
{ name: 'celular', testMatch: /(mobile-nav|team-panel)\.spec\.ts$/u, use: { ...devices['Pixel 5'] } },
```

**O que os três tamanhos realmente cobrem (executado nesta auditoria — 36
passaram):**

| varredura axe | arquivo:linha | onde roda |
| --- | --- | --- |
| gaveta de navegação aberta | `mobile-nav.spec.ts:75` | tablet e celular apenas (`test.skip` acima de 820px) |
| painel de progresso da equipe | `team-panel.spec.ts:82` | mesa, tablet e celular |
| tela do plano | `journey.spec.ts:173` | **só mesa**, com viewport forçado a 390×844 na linha 147 |
| página inteira ao fim da jornada | `journey.spec.ts:285` | **nunca** — código morto depois do `return` da linha 221 (ver H-8) |

**O que NÃO é varrido por axe em tamanho nenhum:** a tela da Ideia (campo de
texto, 7 sugestões, 4 cartões de aparência, `fieldset` de privacidade), a tela
de Perguntas, a tela de Verificação (a lista de critérios de H-3), o
`RunReport`, os `Checkpoints`, o painel de Parada de emergência (incluindo a
confirmação), o `HubPanel` inteiro e a tela do assistente.

**Também não coberto por tamanho:** só existe um ponto de quebra em 820px
(`styles.css:2`), e o projeto "tablet" usa 800px — logo **abaixo** dele. Nenhum
teste roda entre 821px e ~1180px. Ver M-4.

**Correção sugerida:** varrer com axe cada estado terminal da tela principal
(vazio, perguntas, plano, criação, verificação com falha, verificação com
sucesso) e acrescentar um quarto projeto em ~900px.

---

#### M-2 — Vocabulário técnico e nome de motor interno no texto que a pessoa lê

Ocorrências verificadas por busca nos catálogos pt-BR:

| texto exato | arquivo:linha |
| --- | --- |
| "Use a conversa completa do **Harness** para explicar uma tarefa…" | `apps/studio-web/src/i18n/assistant.pt-BR.json:7` |
| "…são os componentes originais do **Harness**. O Studio não mantém uma segunda cópia do chat." | `assistant.pt-BR.json:8` |
| "Abrir no **Harness** (somente instalação pessoal)" | `assistant.pt-BR.json:48` |
| "A interface do **Harness** ainda não está disponível." | `plugins/identity/i18n/pt-BR.json:51` |
| "O **Harness** não preservou o **cwd** isolado da sessão coordenadora." | `plugins/agents/i18n/pt-BR.json:4` |
| "A equipe não pode **reconciliar** enquanto o registro do **Harness** ainda informa trabalho ativo." | `plugins/agent-team/i18n/pt-BR.json:21` |
| "O assistente só trabalha em um **repositório** liberado pelo administrador." | `assistant.pt-BR.json:11` |
| "{tokens} **tokens**, somando {measured} etapa(s) medida(s)." | `apps/studio-web/src/i18n/team.pt-BR.json:23` |
| "**tokens** aproximados" | `assistant.pt-BR.json:60` |
| "A partir de {**commit**}" | `team.pt-BR.json:18` |
| "{count} arquivo(s) mudado(s), {**bytes**} bytes de diferença" | `team.pt-BR.json:17` |
| "Confirme com sua **passkey** antes de iniciar esta tarefa sensível." | `plugins/agents/i18n/pt-BR.json:9` |
| "O **modelo** só pode alterar **src/** e **content/**." | `plugins/prompt-to-app/i18n/pt-BR.json` (`errors.generatedPathRoot`) |
| "O modelo tentou usar um **caminho absoluto**." / "…sair do **diretório** permitido." | idem, `generatedAbsolutePath`, `generatedTraversal` |

Duas coisas se somam aqui. Primeiro, **"Harness" é o nome do motor**, não do
produto: o ledger C-01 só garante que "DeepSeek Harness Studio" não aparece como
marca, e a palavra sozinha escapou 13 vezes. Segundo, a instrução explícita da
auditoria — que a pessoa não precise saber o que é *build*, *container*, *rota*
ou *token* — é contrariada literalmente por `team.pt-BR.json:23`, que mede o
consumo do trabalho **em tokens** e em nada mais.

**Correção sugerida:** substituir "Harness" por "DZ23 STUDIO" nas frases
voltadas à pessoa (a nota de arquitetura de `assistant.pt-BR.json:8` deve
simplesmente sair da tela), traduzir cwd/commit/bytes/repositório, e exibir
consumo em uma unidade que signifique algo (tempo, ou dinheiro quando houver preço).

**Como verificar:** estender `scripts/check-i18n.mjs` com uma lista fechada de
palavras proibidas nos catálogos voltados à pessoa.

---

#### M-3 — "Progresso" no menu leva ao painel de equipes, não ao progresso da criação

**Arquivos:** `apps/studio-web/src/navigation.ts:43`
(`{ id: 'progress', label: team.navLabel, href: TEAM_PATH }` → `/studio/progresso`),
`apps/studio-web/src/i18n/team.pt-BR.json:2` (`"navLabel": "Progresso"`),
`apps/studio-web/src/i18n/pt-BR.json` (`nav.progress`: "Acompanhar criação" —
**chave morta**, confirmado por busca: nenhum uso fora de testes).

**O que a pessoa vê:** o aplicativo dela está sendo criado. Ela clica em
**Progresso** esperando acompanhar. Cai em "O que está acontecendo" /
"Nenhum trabalho em equipe foi iniciado neste projeto."
(`team.pt-BR.json:6`) — outra coisa completamente. O progresso real da criação
está na coluna direita da tela inicial, sob o título "Seu projeto em andamento".

O comentário em `navigation.ts:40-42` diz que unir os dois evitaria "dois nomes
parecidos, um deles morto" — mas o efeito foi o oposto: sobraram dois conceitos
de progresso com um nome só, e o nome aponta para o menos usado.

**Correção sugerida:** renomear o item para "Trabalho em equipe" (que é o que a
tela é) e ligar "Acompanhar criação" ao projeto atual quando ele existir.

---

#### M-4 — Entre 821px e ~950px a tela transborda para os lados

**Arquivo:** `apps/studio-web/src/styles.css:1` e `:2`.

```css
.canvas{ ... grid-template-columns:minmax(480px,1.25fr) minmax(360px,.75fr); gap:40px; padding:34px; max-width:1180px; ... }
@media(max-width:820px){ .canvas{display:flex;flex-direction:column; ...} }
```

Largura mínima do grid: 480 + 360 + 40 (gap) + 68 (padding) = **948px**. Abaixo
de 821px o layout vira coluna. Entre 821px e 948px nenhuma das duas coisas
resolve, e o corpo rola horizontalmente.

**Quem cai aí:** tablet em paisagem (iPad 1024 passa; iPad mini 744 vira coluna;
tablets 8-9" em paisagem e janelas de navegador estreitas em notebook caem na
faixa), Surface Duo, janela lado a lado.

**Por que não é pego:** o projeto "tablet" do Playwright usa **800px**
(`playwright.config.ts:24`) — 21px abaixo do ponto de quebra, ou seja, sempre no
lado seguro.

**Correção sugerida:** trocar o ponto de quebra da coluna para `max-width:960px`,
ou trocar `minmax(480px,…)` por `minmax(0,…)`.

**Como verificar:** um quarto projeto Playwright em 900×800 afirmando
`document.documentElement.scrollWidth <= innerWidth`.

---

#### M-5 — Modo escuro só na tela do assistente; o resto do produto continua branco

**Arquivo:** `apps/studio-web/src/styles.css`. Existem 5 blocos
`@media (prefers-color-scheme:dark)` (linhas 38, 80, 90, 117, 141) e todos
tratam **apenas** `.conversation*`, `.compaction*`, `.approvals*` e
`.stuck-run*`. O próprio comentário na linha 39 admite:

```css
/* O fundo anda com a cor. A folha nao tem `:root` escuro, entao clarear so
   o texto pintava a conversa inteira de claro sobre branco. */
```

**O que a pessoa vê:** no celular em modo escuro, a conversa com o DZ23 é
escura e agradável; ao voltar para "Vamos criar seu aplicativo", a tela dispara
branco puro (`:root{...background:#fff}`). O Hub e o painel de equipe também
ficam brancos.

**Por que atrapalha:** parecem dois produtos diferentes, e o pulo de brilho à
noite é desconfortável — exatamente o público que vai usar isto no sofá.

**Correção sugerida:** ou definir o tema escuro em `:root` e deixar todas as
telas herdarem, ou remover os blocos escuros do assistente para o produto ser
consistentemente claro. Meio-termo é a pior das três opções.

---

#### M-6 — Controles que parecem clicáveis e não são; "Atenção" antes de qualquer leitura

**Arquivo:** `apps/studio-web/src/App.tsx:312` e `:392`, `:70`.

```tsx
<div className="top-actions"><NotificationOptIn /><Bell aria-hidden="true" /><UserRound aria-hidden="true" /> ... </div>
```

`Bell` (sino de notificações) e `UserRound` (conta) são **ícones decorativos**
na barra superior, sem `button`, sem `onClick`, sem destino. Para quem vê, são o
sino e a conta de qualquer aplicativo — clicar não faz nada.

```tsx
function Status({ health }) { ... return <button className={...} aria-label={...}><span />{...}</button> }
```

`Status` é um `<button>` **sem `onClick`**: recebe foco pelo teclado, é anunciado
como botão pelo leitor de tela, e não faz nada. Quando diz "Atenção", não há
como descobrir o que está errado.

```ts
const [health, setHealth] = useState<HealthState>({ state: 'ATTENTION', ... })
```

O estado inicial é `ATTENTION`, então **toda visita começa mostrando "Atenção"**
antes de `/health` responder (`:98`) — um alarme falso a cada carregamento.

**Correção sugerida:** remover os dois ícones decorativos (ou dar-lhes destino);
transformar `Status` num `<button>` que abre o detalhe do que está em atenção
(rota, construtor, disco — os três campos já vêm em `HealthState`); e usar um
estado inicial neutro ("verificando…") em vez de `ATTENTION`.

---

#### M-7 — O livro-razão cita, para E-04, uma prova que a tela atual não sustenta

**Arquivo:** `docs/MASTER_REQUIREMENTS_LEDGER.md`, linha E-04:

> `| E-04 | Mostrar o que sera criado, o que precisa de confirmacao e o que falta | Prompt 5 | v1.0 | BETA | apps/studio-web/src/App.tsx | prompt-to-app | teste: **PlanView lista arquivos e criterios** | — | "o que falta" nao e mostrado |`

`PlanView` **não é mais um componente de tela**: hoje é só um **tipo**
(`apps/studio-web/src/plan/planEdit.ts:17`). A tela do plano é `PlanEditor`, e
ela **deliberadamente não lista os arquivos** — `PlanEditor.tsx:4-8` diz:

```
 * Os ARQUIVOS que serão criados não aparecem como campo: eles são a autorização
 * de escrita do gerador (E-09), e a tela diz isso em uma frase ...
```

e `PlanEditor.tsx:52` mostra apenas `t.plan.filesFixed` = "Os arquivos que serão
criados são definidos pelo Studio e não mudam com a edição."
Confirmado por busca: **`planned_files` não aparece em nenhum arquivo de
`apps/studio-web/src`**.

A decisão de esconder os arquivos é defensável. O problema é a célula de prova:
o requisito é "mostrar o que **será criado**", o estado é BETA (que o portão
exige acompanhado de prova real), e a prova citada descreve um componente que
não existe mais. Nesta linha, o ledger declara mais do que a evidência sustenta.

**Correção sugerida:** reescrever a célula de prova de E-04 para o que a tela faz
hoje ("a tela do plano lista partes, descrições e critérios de aceite; os
arquivos são declarados como decisão do Studio, não listados"), e mover
"lista arquivos" para a coluna de bloqueio junto com "o que falta".

---

#### M-8 — Duas células de prova do ledger descrevem cobertura de axe e de e2e maior do que a executada

**Arquivo:** `docs/MASTER_REQUIREMENTS_LEDGER.md`.

- **U-03**: prova real diz *"axe real sem violacoes na jornada"*. A jornada
  (`journey.spec.ts`) tem duas chamadas a axe: a da linha 173 (só a tela do
  plano) e a da linha 285, que é **inalcançável** (H-8). "Sem violações na
  jornada" descreve uma varredura que nunca aconteceu. A própria linha corrige
  isso no próximo passo ("axe em mais de uma tela"), mas a célula de prova é a
  que se cita.
- **U-05**: testes dizem *"Playwright 24 passando em 3 tamanhos, 1 lacuna
  declarada"*. Executado nesta auditoria: **36 passaram, 3 pulados, 39 no
  total**. O número está desatualizado em 12 testes.

**Nota de método:** `scripts/check-requirements-ledger.mjs:99-101` só verifica
que a célula de prova **não está vazia** (`empty()` recusa `—`, `-`, vazio e
`nenhuma` sozinha). O portão não confere se os testes citados existem, se rodam,
nem quantos são. É por isso que M-7 e M-8 passam com `achados=0`.

**Correção sugerida:** ampliar o portão para conferir que cada caminho de arquivo
citado nas colunas "arquivos"/"testes" existe na árvore. É barato e teria pegado
`PlanView` e a contagem de 24.

---

#### M-9 — "N critérios conferidos" conta critérios que não foram conferidos

**Arquivo:** `apps/studio-web/src/RunReport.tsx:228-229`.

```tsx
{integrityWord(checkpoint.integrity)} · {checkpoint.acceptance_checks.length} {t.checkpoint.criteria}
```

`t.checkpoint.criteria` = **"critérios conferidos"**, mas o número é o
**comprimento da lista inteira** — incluindo os que estão `FAILED`, `PENDING` e
`NOT_AUTOMATED`. O próprio produto tem a palavra certa para o terceiro grupo:
`t.verification.notAutomated` = "Não verificado automaticamente".

**O que a pessoa vê:** "integridade conferida · 12 critérios conferidos" numa
tentativa em que 3 falharam e 5 nunca foram automatizados.

**Correção sugerida:** contar só `status === 'PASSED'`, ou escrever
"12 critérios (7 conferidos, 3 falharam, 2 não automatizados)".

---

#### M-10 — O Hub pede à pessoa leiga o nome de um segredo no cofre, e fala em passkey e T0-T3

**Arquivo:** `apps/studio-web/src/i18n/hub.pt-BR.json`.

- `smtp.help`: "A senha fica no **cofre do servidor**; aqui você informa só o
  **nome que ela recebeu lá**." / `smtp.refLabel`: "Nome do segredo no cofre" /
  `smtp.refPlaceholder`: "Ex.: `DZ23_APP_SMTP`".
- `confirm.T3`: "…só funciona se você já tiver confirmado com a sua **passkey**
  nesta sessão…" — "passkey" aparece sem nenhuma explicação, aqui e em
  `plugins/agents/i18n/pt-BR.json:9`.
- `integrations.tier` traduz T0-T3 muito bem ("Só leitura local", "Fala com
  serviços externos"), mas `integrations.needsApproval` volta ao código:
  "Ligar esta integração precisa da sua confirmação (**{tier}**)" → "(T3)".

**Por que atrapalha:** enviar e-mail é a função mais banal que um aplicativo
criado por um leigo vai querer, e configurá-la exige saber o que é uma variável
de ambiente com segredo no cofre do servidor. Na prática, o público-alvo não
consegue ligar o e-mail sozinho.

**Correção sugerida:** um passo guiado ("quem cuida da instalação precisa
cadastrar a senha; peça a ele o nome e cole aqui"), trocar "passkey" por
"sua chave de acesso" (termo que o próprio produto já usa em
`t.emergency.resumeHelp`), e usar o rótulo em vez do código em `needsApproval`.

---

#### M-11 — O aviso de que 3 das 7 sugestões são protótipos iniciais fica solto embaixo das 7

**Arquivo:** `apps/studio-web/src/App.tsx:354`.

Os sete botões de sugestão são idênticos entre si, e só depois do último vem
`<p className="coming">{t.idea.betaNotice}</p>` = "Agenda, painel e área de
clientes são protótipos iniciais. A verificação mostrará exatamente o que foi
testado e o que ainda falta."

**Por que atrapalha:** a pessoa lê os botões, clica no que quer e continua — o
aviso está depois do ponto de decisão, e exige que ela case três palavras
("Agenda", "painel", "área de clientes") com três dos sete botões. A honestidade
está no texto, mas não chega na hora certa.

**Correção sugerida:** marcar cada um dos três botões com um selo
("protótipo inicial") no próprio cartão.

---

### LOW

---

#### L-1 — Três testes Playwright pulados, um deles a rotação de cookie da prévia

Execução desta auditoria: `3 skipped`. Dois são condicionais legítimos
(a gaveta só existe abaixo de 820px, `mobile-nav.spec.ts:50` e `:73`). O
terceiro é `signout.spec.ts:202` — "ignora rotação de cookie plantado pela
prévia durante a consulta final" — pulado incondicionalmente. Como a prévia
inteira já é inalcançável no e2e (H-8), o comportamento de sessão da prévia não
tem prova de navegador nenhuma.

#### L-2 — Chaves de i18n mortas

`nav.progress` ("Acompanhar criação") não é usada em lugar nenhum fora de testes
(`navigation.ts:43` usa `team.navLabel`). Ver M-3.

#### L-3 — Só Chromium

`playwright.config.ts` usa `Desktop Chrome` e `Pixel 5`, ambos Chromium. Safari
(WebKit) — que é o navegador de todo iPhone, e o público-alvo usa iPhone — não é
testado em lugar nenhum. **O ledger já declara isto** em U-05 ("Ainda e sempre
Chromium: WebKit e Firefox nao sao testados"), então não é omissão: é uma lacuna
conhecida cuja severidade cresce quando o alvo é celular.

---

### FALSE_POSITIVE — coisas que eu procurei e NÃO encontrei

Registro aqui para que a próxima auditoria não gaste tempo:

- **Códigos de checkpoint na tela.** `RunReport.tsx:180-185` traduz os quatro
  bloqueadores (`ACCEPTANCE_ATTESTATION_UNAVAILABLE` etc.) para frases em pt-BR.
  Nenhum código vaza.
- **Nomes técnicos na parada de emergência.** Eu suspeitei de
  `emergency-stop/src/service.ts:239` (`surface: surface.id`), mas `surface.id`
  **já é a string traduzida** (`index.ts:65,74,91` usam `t('surfaces.*')`).
  Nada de cru chega à tela.
- **Caminhos absolutos do computador do host na tela.** Procurados; o painel de
  equipe tem teste explícito contra isso (`team-panel.spec.ts:60`) e o
  `RunReport`/`Checkpoints` não imprimem `run_directory` nem `tree_sha256`.
- **A palavra "pronto".** Zero ocorrências em qualquer catálogo pt-BR ou em
  texto de tela. A única aparição em todo `apps/studio-web/src` está num
  comentário de código (`assistant/markdown.ts:5`, "renderizador pronto"). A
  política é respeitada.
- **Estados vazio/carregando/erro no Hub e no assistente.** São bons de verdade:
  `HubPanel.tsx:390-392` tem o terceiro estado (nulo ≠ vazio), `role="alert"` no
  erro e `role="status"` no aviso; `hub.pt-BR.json` distingue "nada encontrado
  para a busca" de "nenhuma integração passa pelos filtros" de "catálogo vazio".
  O problema (H-7) está concentrado em `App.tsx`, não no produto inteiro.
- **Prova de que nada é publicado.** `journey.spec.ts:210` afirma zero
  ocorrências de "publicado na internet" ao fim de uma execução malsucedida, e
  o e2e passou nesta auditoria. Este ponto está bem defendido.

---

## Resumo por severidade

| severidade | quantidade |
| --- | --- |
| CRITICAL | 3 |
| HIGH | 9 |
| MEDIUM | 11 |
| LOW | 3 |
| FALSE_POSITIVE (verificado e limpo) | 6 |

---

## Veredito

**Não. Uma pessoa leiga não consegue usar isto hoje sem alguém técnico ao lado.**

O produto tem uma qualidade de escrita rara: os catálogos pt-BR são cuidadosos,
o `RunReport` traduz o log em quatro etapas, os checkpoints explicam por que não
há ponto seguro em vez de inventar um verde, o `HubPanel` tem estados vazios
exemplares, e o livro-razão é o documento mais honesto que li neste repositório
— ele confessa os próprios buracos (E-05, U-03, U-05) em vez de escondê-los.
Nada disso é fachada.

Mas três coisas quebram o produto para o público que ele escolheu. A pessoa que
faz exatamente o que a tela pede — escrever a ideia com as próprias palavras —
recebe uma página de apresentação seja qual for o pedido (C-2), porque a
categoria só existe nos sete botões prontos. Se ela clicar em qualquer item do
menu no meio do caminho, o projeto some da tela e não há lista de projetos para
recuperá-lo (C-3). E quando a criação falha ou é cancelada, o painel ao lado
declara **"Protótipo verificado"** (C-1) — a única frase que a política do
projeto existe para impedir, escrita pelo próprio código que foi feito para
impedi-la.

Somando: a criação pode desistir sozinha e chamar isso de falha (H-1), o teto de
gasto vira "problema de verificação" (H-2), o resultado é julgado por uma lista
de `page:Início` e `entity:Cliente` (H-3), a primeira tela pode informar que "o
circuito está em meia-abertura" (H-4), e o erro de último recurso é a palavra
solta **"Atenção"** (H-5) — num produto onde o ícone de **Ajuda** está
permanentemente desligado (H-6).

Nada disso é irreparável, e quase tudo é barato. C-1 são quatro linhas em
`presentation.ts`. C-3 é o `project_id` na URL. H-5 é uma frase. H-6 é uma
página estática. C-2 é a única correção de verdade — mas é a que decide se o
produto faz o que o título promete.

**Antes de mostrar isto a uma pessoa leiga real (a "fase 0.5" que o ledger cita
três vezes), corrija C-1, C-2 e C-3.** Sem C-1 a sessão vai gerar uma conclusão
falsa; sem C-3 ela vai ser interrompida pela primeira curiosidade da pessoa;
sem C-2 ela vai testar o gerador errado — que é exatamente o erro que o próprio
projeto já cometeu uma vez, e registrou em P-07 do ledger.
