# Auditoria A — Arquitetura / Engenharia

**Objeto:** `/home/claude/integ`, `HEAD = dba2787`, base `f1677b4` (M89).
**Escopo:** o que entrou em `f1677b4..HEAD` (31 commits, 97 arquivos, +6295/-262).
**Auditor:** A — Architect / Engineering. Revisão somente leitura.

## Veredito

**NEEDS_FIX**

Não porque a integração esteja quebrada em produção hoje — ela não está, e o
typecheck e todas as suítes que rodei passam — mas porque três coisas que a
candidata afirma sobre si mesma não se sustentam quando verificadas:

1. o `action-approval` é vendido como autoridade **durável** e sua segurança
   concorrente depende inteiramente de uma escrita condicional (CAS) que a
   camada de armazenamento do projeto **não oferece**, e da qual não existe
   nenhuma implementação durável no repositório;
2. o script `pnpm prove:agent-restart` — citado como prova de reinício —
   **falha por construção** desde o merge do M75-B e ninguém o reexecutou;
3. `plugins/*/lib` continua **rastreado no git e desatualizado** (63 arquivos
   divergem de um build do `src` atual), incluindo justamente o código de
   segurança de `identity` e `agents` que esta integração alterou. O
   `.gitignore` que foi acrescentado não desrastreia nada.

Nenhum dos três exige rescrever a fatia. Todos exigem uma correção antes de
chamar isto de release.

## Verificação executada

| Comando | Resultado |
|---|---|
| `npx tsc --noEmit` | **PASS** (12,4 s, saída vazia) |
| `npx vitest run plugins/action-approval plugins/staging/tests/approval-adapter.spec.ts plugins/agents plugins/agent-team plugins/identity plugins/studio-web` | **PASS** — 22 arquivos, 228 testes |
| `npx vitest run plugins/storage-postgres` | **PASS** — 18 arquivos, 171 testes, 6 arquivos / 60 testes **SKIP** (exigem `DZ23_POSTGRES_TEST_DSN`) |
| `npx vitest run src/assistant` em `apps/studio-web` | **PASS** — 6 arquivos, 34 testes |
| `node scripts/check-i18n.mjs` | **PASS** — `catalogs=15 keys=290` |
| `npx tsx scripts/check-domain-scopes.ts` | **PASS** |
| `node scripts/prove-agent-restart-runtime.mjs` | **NÃO VERIFICADO em execução** — o script fixa `HOME` num diretório isolado nos filhos (`scripts/prove-agent-restart-runtime.mjs:184`), então o `safe.directory` global não é lido e o `git` do submódulo aborta com *dubious ownership* antes de qualquer asserção. O defeito abaixo (H3) é provado estaticamente. |

`pnpm build` não foi executado (proibido pelo escopo); as afirmações sobre
`lib` são feitas comparando o conteúdo **rastreado em `HEAD`** com o `src`
atual e com a árvore de trabalho, não com um build novo meu.

## Achados

| # | Sev | Arquivo:linha | Descrição | Evidência | Correção sugerida |
|---|---|---|---|---|---|
| H1 | HIGH | `plugins/action-approval/src/repository.ts:11`, `:20`; `src/service.ts:96,171,247` | A exclusão mútua de `confirm`/`consume` é delegada 100% a `put(record, expectedState)` — uma escrita condicional. A **única** implementação é `InMemoryActionApprovalRepository`, e o seam de armazenamento do projeto (`KvTable.put(key, value)`, `third_party/deepseek-harness/packages/*/storage-domain/src/domain.ts:72`) **não tem escrita condicional**. Um adaptador durável sobre esse seam faria read-then-write sem serialização (o serviço não usa mutex algum, ao contrário de `identity`), e dois `consume` concorrentes emitiriam dois recibos para a mesma confirmação — exatamente o que o commit diz impedir. | `grep -rn "ActionApprovalRepository"` só encontra `repository.ts` e testes; `domain.ts:72` expõe `put(key,value)` sem `expected`. | Ou implementar `put` condicional no seam durável (versão/geração na linha), ou serializar por `approval_id` com `KeyedMutex` como `identity` faz, e só então chamar a autoridade de durável. |
| H2 | HIGH | `plugins/identity/lib/**`, `plugins/agents/lib/**`, `plugins/storage-postgres/lib/**` (+5 pacotes) | 114 arquivos sob `plugins/*/lib/` continuam **rastreados**; `git status` mostra **63 deles modificados** contra a árvore construída. `plugins/*/package.json` resolve `exports.default = "./lib/index.js"` e o profile carrega os plugins **por nome de pacote** (`dsh-home/profiles/studio/package.json`), logo produção executa `lib`. Os testes, ao contrário, usam alias para `src` (`vitest.config.ts:9`). Consequência concreta: `git show HEAD:plugins/identity/lib/service.js:228` ainda tem o `bindHarnessSession` **sem teto e sem exclusividade** e não tem `releaseHarnessSession`; `git show HEAD:plugins/identity/lib/http.js:181` ainda expõe a rota `/bind-agent` que esta integração removeu; `git show HEAD:plugins/agents/lib/model.js` não conhece `UNKNOWN` (0 ocorrências, contra 2 no build atual). O `.gitignore` acrescentado (`plugins/*/lib/`) não afeta arquivos já rastreados. | `git status --porcelain plugins/*/lib \| wc -l` → 63; comparações citadas acima. | `git rm -r --cached plugins/*/lib` num commit próprio, e um gate que falhe se `plugins/*/lib` voltar a aparecer em `git ls-files`. Enquanto isso não acontece, `pnpm build` é obrigatório e não opcional — o `docs/BOOTSTRAP.md` já diz isso, mas o repositório contradiz o documento. |
| H3 | HIGH | `scripts/prove-agent-restart-runtime.mjs:124,150-151,158-159,166-167` | `assert.deepEqual(ctx.studioAgents.restartReconciliation, expectedCounts.agents)` compara contra objetos que só têm `interruptedRuns`, `releasedLeases` e `reconciledAt`. O M75-B (`90713a7`) passou a devolver **cinco** campos (`service.ts:369-375`: `+unresolvedRuns`, `+keptLeases`) e **não tocou o script** (`git log -- scripts/prove-agent-restart-runtime.mjs` para em `2612137`, anterior ao M75-B). `assert.deepEqual` do Node reprova chaves extras — verificado: `node -e "assert.deepEqual({x:1,y:2,z:3},{x:1,y:2})"` → `FAILED: Expected values to be loosely deep-equal`. As três fases falham. Além disso o `reconciledAt` esperado é lido **do próprio objeto sob teste** — a asserção é tautológica mesmo quando passa. | Execução real bloqueada pelo ambiente (ver tabela acima); defeito provado por leitura + semântica do `assert` demonstrada. | Atualizar os objetos esperados com `unresolvedRuns`/`keptLeases` e trocar `reconciledAt: <o próprio valor>` por uma checagem de formato/ordem temporal. Reexecutar o script como parte do gate do M75-B, que hoje não o lista. |
| H4 | HIGH | `plugins/agents/src/service.ts:383`; `plugins/agent-team/src/service.ts:200-230` | O estado `UNKNOWN` é bloqueante (`service.ts:254-261` recusa `start()` em caminhos reservados) e sua **única** saída é `resolveUnknownRun`, que não tem rota HTTP, não está no catálogo de ferramentas do Assistente (`plugins/assistant-bridge/src/catalog.ts:5-10`) e não é chamada em lugar nenhum fora dos testes. O próprio `docs/proofs/M75B-external-worker-proof.md` admite `NOT_IMPLEMENTED` para a superfície — honesto, mas o efeito é que os arquivos ficam reservados sem caminho de volta para quem usa o produto. Pior: `resolveUnknownRun` não propaga para `agent-team`; a tarefa da equipe fica `UNKNOWN` (e a equipe em `NEEDS_ATTENTION`) até o **próximo reinício**, porque `reconcileInterruptedTeams` só roda em `apply()`. | `grep -rn "resolveUnknownRun"` → só `service.ts:383` e `tests/service.spec.ts`. | Expor a resolução (rota autenticada T2/T3 + tela) e, no mesmo caminho, reconciliar a tarefa da equipe correspondente em vez de esperar o reinício. |
| M1 | MEDIUM | `plugins/agents/src/service.ts:404`; `plugins/agents/src/index.ts:98-107,180-188` | `shutdown(deadlineMs)` — o "encerramento ativo com prazo" — **nunca é chamado**. `apply()` registra `ctx.effect` só para fechar os domínios e soltar o grant de delegação; nenhum efeito chama `service.shutdown()`. Na prática, no encerramento os domínios fecham enquanto execuções em voo continuam, e o cancelamento com prazo é código morto testado. | `grep -n "ctx.effect" plugins/agents/src/index.ts` → linhas 98 e 107 apenas; `grep -rn "\.shutdown(" ` não encontra chamada ao método do serviço. | `ctx.effect(() => async () => { await service.shutdown() }, 'studio-agents.shutdown')`, registrado **antes** do fechamento dos domínios para que a ordem de teardown seja a inversa. |
| M2 | MEDIUM | `plugins/agents/src/service.ts:420-430` | `#hasPersistedWork()` chama `#unknownRunIds()` **dentro do predicado do `.some`**, reconstruindo um `Set` sobre todas as execuções a cada lease ativa: O(leases × runs). Roda no construtor (`:214`) e no fim de toda reconciliação (`:365`). | Leitura direta: `leases().some(lease => lease.active && !this.#unknownRunIds().has(lease.run_id))`. | Içar `const unknown = this.#unknownRunIds()` para fora do `.some`. |
| M3 | MEDIUM | `plugins/studio-web/src/assistant-conversation.ts:88-93` | O `try/catch` de `snapshot()` engole **tudo** e devolve `NOT_FOUND`. Uma indisponibilidade do controlador, um `AbortError` do deadline de 30 s (`assistant-http.ts:14,92`) ou um bug da própria projeção viram "a conversa não existe". O teste em `tests/assistant-conversation.spec.ts:120-122` **codifica** esse comportamento. É o oposto do princípio que o próprio `action-approval` enuncia ("erro de armazenamento continua erro") e é inconsistente com `send()`, que mapeia a mesma classe de falha para `SESSION_UNAVAILABLE`/503. O cliente trata 404 como definitivo (`apps/studio-web/src/assistant/conversationApi.ts:138`: `retryable = status >= 500 \|\| status === 429`), então uma queda momentânea vira beco sem saída na tela. | Linhas citadas + teste que fixa o comportamento. | Distinguir "não encontrado" (o erro específico do controlador) de "não deu para saber" (`SESSION_UNAVAILABLE`), como `send()` já faz. |
| M4 | MEDIUM | `plugins/studio-web/src/index.ts:88-110` | No `catch` do handler, `IdentityError` vira status 401 (ou 429 se `locked`) e é escrito com `send()`, ou seja **`text/plain`**, mesmo quando a requisição era da API JSON de conversa. Duas consequências: (a) `bindHarnessSession` lançando `invalid` (teto de vínculos, `identity/src/service.ts:406`) ou `replay` (conflito de vínculo, `:401`) chega ao cliente como **401 de autenticação**, não como o erro que é; (b) `conversationApi.readBody` faz `response.json().catch(() => undefined)`, então a mensagem catalogada é descartada e a pessoa recebe o texto genérico `copy.openError`, sem retry. | Mapeamento em `index.ts:92-101`; `send()` em `index.ts:198-202`; descarte em `conversationApi.ts:127-128,136-139`. | Mapear `IdentityError` por código (teto → 409, conflito → 409, sessão expirada → 401) e responder JSON quando a rota é de conversa. |
| M5 | MEDIUM | `plugins/identity/src/service.ts:445,459,472,485,608` | `ownsHarnessSession` e `#usableHarnessSessionBinding` fazem `#repository.sessions().filter(...)` — e `sessions()` materializa **a tabela inteira** (`plugins/identity/src/index.ts:140`, `values(this.sessionTable)`). Isso acontece em `#assertOwned` de **toda** requisição da conversa (`assistant-conversation.ts:133`) e em `identityStateForHarnessSession`/`principalForHarnessSession`, que o bridge do Assistente consulta por autorização de ferramenta. É varredura completa em caminho quente, e a tabela cresce com sessões revogadas. | Linhas citadas; `index.ts:140`. | Índice `harness_session_id → session_id` mantido na escrita (já serializada pelo mutex global `harness-session-bindings`), ou cache invalidado por geração. |
| M6 | MEDIUM | `plugins/storage-postgres/src/dsn.ts:157-167` | `applyTargetEnvironment` só **define** variáveis quando o campo existe na URI; nunca **neutraliza** as herdadas. `env` começa com `...base` (`:176`), e `base` é `process.env` no caminho real (`restore-policy.ts:93`). Uma DSN sem porta explícita, ou sem usuário, ou sem caminho de banco, deixa `PGPORT`/`PGUSER`/`PGDATABASE` do operador valerem — que é a mesma classe de erro que a fatia acabou de corrigir: o backup de segurança sairia de um alvo que ninguém declarou, e o restore destrutivo seguiria confiando nele. `parseDsn` (`:89`) aceita qualquer URL, sem sequer exigir esquema `postgresql://`. | Leitura das linhas; `restore-policy.ts:93` passa `process.env`. | Definir explicitamente as quatro variáveis a partir da URI e `delete` quando o campo estiver ausente (ou recusar a DSN incompleta). Um teste com `base = { PGHOST: 'outra-maquina' }` e DSN sem host prova a correção. |
| M7 | MEDIUM | `plugins/studio-web/src/assistant-session.ts:182-187` | Se a conversa vinculada inspeciona com `cwd` diferente do repositório configurado, o launcher lança `SESSION_CONFLICT` e **não libera** o ponteiro nem tenta o próximo candidato. Como o loop testa os candidatos em ordem, basta que o **primeiro** esteja nessa condição para que toda tentativa de abrir a conversa falhe para sempre. Diferente de `releasedMissing`/`releasedForeign`, este ramo não tem saída automática, e `releaseHarnessSession` não tem superfície pública. | Linhas 178-187 (`released*` fazem `continue`; o de `cwd` faz `throw`). | Tratar divergência de `cwd` como ponteiro inservível: registrar e liberar (`#release`) e continuar, ou expor uma ação de "esquecer esta conversa". |
| L1 | LOW | `plugins/agent-team/src/service.ts:222-223` | `reconcileInterruptedTeams` chama `#teamTasks(team.team_id)` para cada equipe não terminal, e `#teamTasks` (`:318-322`) varre **todas** as tarefas: O(equipes × tarefas) no boot. | Leitura direta. | Agrupar as tarefas por `team_id` uma vez antes do laço. |
| L2 | LOW | `apps/studio-web/src/assistant/conversationState.ts:48,56` | A fila de mensagens enviadas é limpa comparando **texto**: `delivered = new Set(events.filter(isUserMessage).map(e => e.text))`. Duas mensagens iguais ("ok", "sim", "continue") em sequência: o eco da primeira apaga as duas da fila, e a segunda deixa de aparecer como pendente antes de existir no journal. | Linhas 48 e 56. | Casar por `request_id` (exigiria o servidor ecoá-lo) ou consumir por contagem em vez de por conjunto. |
| L3 | LOW | `plugins/storage-postgres/src/dsn.ts:145`; `plugins/agents/i18n/pt-BR.json` (`recovery.shutdownDeadline`); `apps/studio-web/src/assistant/conversationState.ts:135` | Código e recursos mortos deixados pela fatia: (a) `PostgresToolConnection.dsn` não tem mais nenhum consumidor de produção depois que `restore-policy.ts:99` passou a usar só `target.env`; (b) a chave `recovery.shutdownDeadline` foi catalogada e nunca é usada (`shutdown()` não chama `t()`); (c) em `compactionView`, `if (current !== null && event.seq < current.seq) continue` é inalcançável, porque `state.events` já vem ordenado crescente por `seq` (`:46`). | `grep -rn "postgresToolConnection"` só mostra `restore-policy.ts` e testes; `grep -rn "shutdownDeadline"` só mostra o JSON. | Remover os três. O gate de i18n atual (PASS) não detecta chave órfã — vale acrescentar essa checagem. |
| I1 | IMPROVEMENT | `plugins/action-approval/tests/service.spec.ts:206` | `expect(receipts.length).toBeGreaterThanOrEqual(1)` no teste de consumo concorrente. Com o repositório em memória o valor é deterministicamente 2; a asserção aceitaria 1 e não distingue "convergiu" de "um dos dois se perdeu". O que salva o teste é o `toEqual(receipts[0])` da linha seguinte. | Linha 206. | Fixar `toHaveLength(2)` e manter a igualdade dos recibos. |
| I2 | IMPROVEMENT | `plugins/studio-web/tests/assistant-conversation.spec.ts:33` | `identity: { ownsHarnessSession: () => input.owned !== false }` — a regra de posse é substituída por uma constante. `AssistantConversationService` e `StudioIdentityService` nunca são exercitados juntos; cada lado prova a sua metade. É o tipo de costura onde um `harness_session_ids` liberado por um lado e ainda aceito pelo outro passaria despercebido. | Linha 33. | Um teste de integração com o `StudioIdentityService` real e um repositório em memória, cobrindo vincular → ler → liberar → ler. |
| I3 | IMPROVEMENT | `apps/studio-web/src/assistant/conversationState.ts:40-58` | `applySnapshot` faz **união** por `seq` e nunca poda: o cliente acumula todo evento já visto, mesmo os que o servidor deixou de enviar (o servidor corta em 500, `assistant-conversation.ts:16`). Custo O(n log n) por poll e memória monotônica numa conversa longa. `truncated` também nunca volta a `false`. | Linhas 42-47, 54. | Limitar o estado ao mesmo teto do servidor, descartando os `seq` mais antigos. |

**Contagem:** CRITICAL 0 · HIGH 4 · MEDIUM 7 · LOW 3 · IMPROVEMENT 3.

## Respostas às perguntas

### Arquitetura e limites

A direção declarada está correta e é verificável. `plugins/action-approval`
**não importa staging em lugar nenhum**: suas únicas dependências são
`@deepseek-ai/dsh-storage-domain`, `@dz23-studio/policy` e `zod`
(`plugins/action-approval/package.json:20-23`), e nenhum arquivo de
`plugins/action-approval/src/**` menciona staging. A seta é a inversa e é
explícita: `plugins/staging/package.json:23` acrescentou
`"@dz23-studio/action-approval": "workspace:*"`, e
`plugins/staging/src/approval-adapter.ts:1-8` importa a autoridade genérica e
a projeta para o contrato do staging via `stagingApprovalReceiptSchema.parse`
(`:69`), que é estrito e derruba `tier`/`claim_id`. Isso é um adaptador que
paga o próprio custo: o `parse` é a prova de que só o contratado atravessa.

Não encontrei ciclo novo. O grafo desta fatia é `staging → action-approval`,
`studio-web → {identity, tenancy, assistant-bridge, policy}`,
`agent-team → agents`, todos numa direção só.

O que **não** está bem é o outro lado do limite: o `action-approval` é uma
fatia vertical completa (modelo, domínio, repositório, serviço, HTTP, i18n,
testes, gate de escopo de domínio) que **não está ligada em nada**. Não
aparece em `dsh-home/profiles/studio/package.json`, a rota
`/studio/approvals` (`src/http.ts:5`) não é registrada em nenhum servidor,
`handleApproval`/`approvalStatus` não têm chamador, e
`StagingActionApprovalAdapter` só é construído em teste. Não é um erro de
arquitetura — é uma fatia entregue sem a última costura — mas explica por que
o H1 ainda não machucou ninguém, e é a razão de eu não classificar o H1 como
CRITICAL.

### Concorrência

**Confirmar/consumir aprovação.** O desenho está certo *no papel*: `#owned`
lê, expira se preciso, e toda transição escreve com
`put(record, expectedState)`, um compare-and-swap. Os dois pontos delicados —
`request` (`service.ts:88-102`) e `consume` (`:166-179`) — tratam o conflito
lendo o vencedor e só devolvendo recibo se a reivindicação for **idêntica**.
Isso é correto e é o padrão certo. O problema é que o CAS não existe abaixo
(H1): sem ele, há leitura-depois-escrita sem condição, com `await` entre a
checagem (`#owned`, `:189`) e o uso (`#write`, `:171`), e sem nenhum mutex
para cobrir o intervalo. Repare no contraste com `identity`, que resolveu o
mesmo problema com `KeyedMutex` — `authenticate` (`service.ts:312`),
`revokeSession` (`:362`), `bindHarnessSession` (`:391`) e
`beginPasskeyAuthentication` (`:581`) agora **releem o registro dentro do
lock** em vez de confiar no snapshot recebido, que é exatamente a correção
certa. A ordem de aquisição é consistente (`harness-session-bindings` →
`session:<id>`, nunca a inversa), então não vejo deadlock.

**Reconciliação de agentes.** Segura o suficiente. A janela é o boot, antes de
`ctx.jobs.attachController` e antes de `ctx.provide`
(`plugins/agents/src/index.ts:180-183`), e `#ready` (`service.ts:214,331,368`)
mantém `start()` fechado enquanto ela roda. A checagem de `hasLiveJobs()` é
repetida antes e depois da varredura (`:332,338,365`) — defensiva, e as três
chamadas custam O(agentes × jobs), mas só no boot. A ordem entre plugins está
certa: `agent-team` declara `inject: [..., 'studioAgents']`, então lê runs já
reconciliadas.

**Fusão do snapshot da conversa.** `applySnapshot` é genuinamente idempotente
e monotônica: união por `seq`, cursor por `Math.max`, ordenação explícita
(`conversationState.ts:42-47`). Não achei corrida ali. O estado em memória que
me preocupa é outro: `#activeByIdentitySession`
(`assistant-session.ts:58,130,202`) e `#activePaths`/`#inFlight`
(`agents/service.ts:195-196`) são caches de processo. O `#activePaths` já
estava sendo levado a sério — o M75-B corretamente acrescentou a checagem da
reserva **durável** em `start()` (`:254-261`), porque a versão em memória não
sobrevive a reinício e "preservar a reserva sem isso teria sido teatro", como
o próprio commit diz. Concordo com o diagnóstico e com a correção.

### Recuperação

Para cada estado novo, depois de um reinício:

- **`RUNNING` interrompida, provedor `spawn-in-process`** → `FAILED`, reserva
  liberada. Correto: o processo morre junto com o Studio, então o reinício
  **é** a prova.
- **`RUNNING` interrompida, provedor `codex`/`claude-code`** → `UNKNOWN`,
  reserva **mantida**. Também correto, e é a decisão difícil certa: sem
  identidade de processo no seam do Harness, declarar morte seria inventar
  evidência.
- **`UNKNOWN`** → **estado do qual não há saída na prática** (H4). Existe
  `resolveUnknownRun`, testada, sem rota, sem tela, sem ferramenta. E mesmo
  usando-a por dentro, a tarefa correspondente em `agent-team` continua
  `UNKNOWN` até o próximo boot. Este é o achado de recuperação da auditoria.
- **`UNKNOWN` de tarefa de equipe** → equipe em `NEEDS_ATTENTION` (correto,
  `FAILURE_STATUSES` inclui `UNKNOWN`), tarefa presa.
- **Aprovações `PENDING`/`AVAILABLE`** → expiram por relógio (`APPROVAL_TTL_MS`
  = 3 min) na próxima leitura; `#owned` expira antes de qualquer uso. Sem
  estado preso. Bom desenho.
- **Ponteiros de conversa (`harness_session_ids`)** → só saem por
  `releaseHarnessSession`, chamada apenas quando o Harness **provou** que a
  conversa sumiu ou não é do preset (`assistant-session.ts:169,179`). Correto,
  exceto o ramo de `cwd` divergente, que não libera e trava (M7).

Um ponto que **não** é defeito e merece registro: o Studio não fica
inutilizável por causa de um `UNKNOWN`. `#hasPersistedWork()` exclui
deliberadamente as leases de execuções `UNKNOWN` (`service.ts:422-423`), então
`#ready` continua `true` e só os caminhos reservados ficam bloqueados. Foi
pensado.

### Performance

Sim, há um O(n²) e há varredura completa em caminho quente.

- **O(n²) real:** `#hasPersistedWork` (M2), reconstruindo o `Set` de
  `UNKNOWN` por lease. E `reconcileInterruptedTeams` (L1), varrendo todas as
  tarefas por equipe. Ambos no boot, então é latência de inicialização, não de
  requisição.
- **`bindHarnessSession`** em si é O(sessões) por chamada
  (`identity/src/service.ts:394-397`), mas é chamada uma vez por abertura de
  conversa e está sob mutex — aceitável. O problema não é ele, é
  `#usableHarnessSessionBinding` (M5), na mesma família, que roda **por
  requisição** de conversa e por autorização de ferramenta e faz varredura
  completa da tabela de sessões.
- **`start()` de agents** ganhou uma varredura completa de `leases()`
  (`service.ts:254`) por delegação. É O(leases-de-todo-o-histórico) e as
  leases inativas nunca são podadas. Não é urgente, mas cresce sozinho.
- **`compactionView`** é O(eventos) por chamada, sobre no máximo 500 eventos
  do servidor — mas o cliente acumula sem teto (I3), então na prática cresce
  com a conversa e é recomputado a cada render (não vi `useMemo` no
  `Conversation.tsx`). O algoritmo em si está bem: uma passada, monótono por
  `PHASE_RANK`, sem retrocesso.
- **`snapshot`** busca o journal inteiro e reprojeta a cada poll
  (`assistant-conversation.ts:89`); não há leitura incremental por cursor,
  apesar de o cursor existir no contrato. É o custo dominante do transporte e
  o lugar óbvio para a próxima otimização.

### Manutenção

Duplicação entre `src` e `lib`: **sim, e é o H2** — a pior forma dela, porque
não é cópia visível, é artefato rastreado que produção carrega e teste não.
O `.gitignore` acrescentado nesta linha reconhece o problema por escrito
("committed copies drifted from src (route-health lacked markScope since
b44ffe4)") e não o resolve.

Código morto: os três itens do L3. A abstração que mais me preocupa em
custo-benefício é o `action-approval` inteiro — 590 linhas de `src` + 522 de
teste + entrada no gate de escopo de domínio + alias no vitest, tudo para uma
autoridade que ninguém chama e cuja garantia central não tem implementação
durável. Não é abstração ruim; é abstração **entregue pela metade**, e
enquanto ficar assim ela paga custo sem entregar nada.

Do lado positivo, vale dizer o que está bem feito: a separação
roteamento-puro/handler em `assistant-http.ts` e `action-approval/http.ts`
torna provável por teste inclusive as rotas que **não** devem existir, e o
comentário em `service.ts:157-159` que explica por que **não** há checagem de
expiração no `consume` ("repetir seria código morto — e código morto num
caminho de segurança é onde um erro se esconde") é o tipo de raciocínio que eu
queria ver mais vezes.

### Testes

A maioria dos testes novos pode falhar de verdade. Verifiquei mutando
mentalmente cada guarda das fatias e as asserções batem no ponto: os
`toMatchObject({ code: 'X' })` que aparecem em massa em
`plugins/action-approval/tests/` carregam o campo discriminante (`code`), que
é justamente o que os torna aceitáveis; o teste de vínculo concorrente em
`plugins/identity/tests/service.spec.ts:315-345` exercita `Promise.allSettled`
com dois vínculos disputando o mesmo `harness_session_id` e exige
`fulfilled == 1 && rejected == 1` mais a contagem no repositório — isso não
passa por acidente; e `plugins/agents/tests/service.spec.ts:261-283` prova o
prazo de `shutdown` nos dois lados (`{stopped:0,pending:1}` e
`{stopped:1,pending:0}`).

O que reprovo:

1. **`scripts/prove-agent-restart-runtime.mjs` (H3)** — o caso mais grave.
   Além de estar quebrado, quatro das suas asserções afirmam
   `reconciledAt: <o próprio valor que o código acabou de calcular>`. Isso é
   exatamente o padrão "teste que afirma o que o código acabou de calcular".
2. **`toBeGreaterThanOrEqual(1)` (I1)** em asserção de concorrência.
3. **Costura não testada (I2)** — a posse do `harness_session_id` é
   substituída por constante em todo o teste da conversa.
4. **`assistant-conversation.spec.ts:120-122`** codifica como *desejado* o
   comportamento que considero errado no M3: um erro de armazenamento com
   caminho `/private` vira 404. O teste cumpre o que se propõe (não vazar o
   caminho) e cimenta o defeito ao lado.
5. **Cobertura ausente para o M6**: nenhum teste passa um `base` com
   `PGHOST`/`PGPORT` de outro alvo e uma DSN incompleta — que é o cenário que
   a própria fatia diz estar corrigindo.

Registro também que 60 testes de `storage-postgres` ficam SKIP sem
`DZ23_POSTGRES_TEST_DSN`. Não julgo isso defeito — é a decisão certa para um
teste que precisa de banco real — mas quem ler "171 PASS" precisa saber que o
caminho corrigido do `pg_dump` não foi exercitado contra um Postgres nesta
verificação.

### Empacotamento

Respondido no H2, e a resposta é a mais dura da auditoria: **não, `lib` não
está coerente com `src`**, e **sim, há consumidor que carrega `lib` e portanto
rodaria código velho** — o profile do Studio carrega os plugins por nome de
pacote, e `exports.default` aponta para `lib/index.js`. Os 63 arquivos
divergentes incluem `identity/lib/service.js` (sem teto de vínculos, sem
liberação, sem exclusividade), `identity/lib/http.js` (com a rota
`/bind-agent` que esta integração removeu por segurança) e `agents/lib/model.js`
(sem `UNKNOWN`, domínio v2 contra v3 no `src`).

Existem duas atenuações honestas. Primeira: `@dz23-studio/web` (studio-web)
**não** tem `lib` rastreado, então uma instalação limpa sem build falharia ao
carregar esse plugin — a falha seria barulhenta, não silenciosa. Segunda:
`docs/BOOTSTRAP.md`, adicionado nesta mesma integração, torna `pnpm build`
obrigatório e ainda manda reportar qualquer mudança em `plugins/*/lib/**` em
vez de apagá-la. É a atitude certa. Mas um repositório em que a segurança
depende de alguém lembrar de um passo é um repositório que já foi mordido uma
vez e deixou os dentes no lugar. Desrastrear é uma linha de comando.
