# AUDITOR A/B — Arquitetura + Segurança — commit `ad004c2`

**Objeto:** `ad004c2` ("S-08: o Hub sai da chave-valor, e o mapa dos 25 restantes para de mentir")
e o seguimento `28bb1b4` (livro-razão / estado da missão).
**Método:** leitura adversarial do código + FALSIFICAÇÃO por mutação (todas restauradas).
**Baseline:** `npx tsc --noEmit` = 0; `npx vitest run plugins/integration-hub plugins/mcp-client --maxWorkers=1`
= 25 arquivos / 278 testes, tudo verde; `npx tsx scripts/check-rls-coverage.ts --self-test` =
`RLS_COVERAGE_SELF_TEST=PASS checks=6`, `RLS_COVERAGE=PASS migrados=2/26`.

---

## Placar

| # | Item alegado pelo autor | Veredito |
|---|---|---|
| 1 | Leituras do `HubRepository` viraram assíncronas e escopadas | **CORRIGIDO** |
| 2 | `TenantRecordHubRepository` põe integrações, exportações e eventos na tabela por inquilino com RLS | **PARCIAL** — correto no isolamento de leitura; escrita escopada pelo corpo do registro, custo de leitura amplificado, e a "segunda tranca" só é testada em uma das três tabelas |
| 3 | Seletor `hubRepository()` com `storageAuthority`, padrão `kv`, falhando alto | **CORRIGIDO** |
| 4 | Reclassificação de 11 domínios + categoria `startup-reconciliation` + piso 2 | **PARCIAL** — as afirmações centrais são VERDADEIRAS e eu as conferi no código; 5 das 11 linhas têm motivo escrito FALSO (conservadorismo, não otimismo) |
| 5 | Teto do `hub-binding` de 700 ms → 3 s | **CORRIGIDO** |

---

## O que eu FALSIFIQUEI (mutação → resultado)

Todas as mutações foram desfeitas com `git checkout --` e conferidas.

| # | Mutação | Resultado |
|---|---|---|
| F1 | `tenant-repository.ts`: removi o filtro `#inScope` de `integrations()` e de `integration()` | **MORTA** — `tenant-repository.spec.ts` "uma linha gravada com o escopo errado no corpo some da leitura" reprova |
| F2 | `tenant-repository.ts`: `#exclusive()` passa a executar `work()` direto (sem fila) | **MORTA** — "duas trocas condicionais concorrentes: só uma passa" reprova |
| F3 | `pruneEvents`: `rows.slice(0, rows.length - keep)` (apagar os NOVOS em vez da cauda) | **MORTA** — "a retenção corta a CAUDA" reprova |
| F4 | `export()`: removi a conferência `value.project_id !== projectId` | **SOBREVIVEU** — 11/11 testes passam. Ver achado A-04 |
| F5 | `exports()` e `#events()`: removi o `#inScope` das duas | **SOBREVIVEU** — 11/11 testes passam. Ver achado A-04 |
| F6 | `index.ts` (`DomainHubRepository`): `integrations()` ignora o escopo e devolve todos os inquilinos | **MORTA** — 1 de 243 testes reprova (`index.spec.ts:147`). Sobrevive a `service.spec.ts` inteiro, porque este usa o próprio `MemoryRepository` |
| F7 | `check-rls-coverage.ts`: devolvi `studio_policy_audit` para `category: 'ready'` mantendo o texto | **SOBREVIVEU** — `RLS_COVERAGE=PASS`, self-test PASS, apenas o resumo por categoria muda. Ver achado A-02 |
| F8 (sonda) | Escrevi uma spec descartável executando `IntegrationHubService` REAL contra `TenantRecordHubRepository` para provocar dois `configureSmtp` concorrentes | **NÃO REPRODUZIU** — ver A-10 (FALSO-POSITIVO). Arquivo removido |

---

## Achados

### A-01 · MEDIUM · A reclassificação de 5 dos 11 domínios tem motivo escrito FALSO

**Evidência.** `scripts/check-rls-coverage.ts:83-89` classifica `studio_app_specs`,
`studio_design_specs`, `studio_intake_turns`, `studio_plans` e `studio_evidence` como
`startup-reconciliation` com o motivo *"idem studio_projects, mesmo repositorio e mesma varredura
de inicio"*.

**Causa.** A varredura de início existe e é real, mas ela NÃO toca essas cinco tabelas.
`plugins/prompt-to-app/src/service.ts:311-353` (`reconcileInterruptedExecutions`) lê e escreve
exatamente três coisas: `runs()`, `projects()` e `putApproval()`. Nenhum `specs()`, `designs()`,
`turns()`, `plans()` ou `evidence()` aparece nela. Conferi todas as leituras desses cinco domínios —
`service.ts:96, 110, 123, 140, 158, 173, 310, 363` — e **todas** recebem `actor` e filtram por
`#sameScope(actor, value)`. Além disso, são oito domínios de armazenamento independentes
(`plugins/prompt-to-app/src/model.ts:184-191`), abertos um a um em `index.ts:139-143`: "mesmo
repositório" não os acorrenta.

**Impacto.** Baixo em segurança (o erro é CONSERVADOR: marca como difícil algo que é fácil, ao
contrário do erro anterior, que era otimista). Alto em confiança: o commit se apresenta como "o mapa
para de mentir", e cinco das linhas novas afirmam um fato que o código contradiz. Também esconde as
5 migrações mais baratas que restam — justamente o próximo passo prático do S-08.

**Reprodução.** `grep -n "#repository\.\(evidence\|plans\|specs\|designs\|turns\)(" plugins/prompt-to-app/src/service.ts`
— toda ocorrência traz `actor` e `#sameScope`; comparar com `sed -n '311,353p'` do mesmo arquivo.

**Correção sugerida.** Manter `startup-reconciliation` apenas em `studio_projects`, `studio_runs` e
`studio_approvals` (esses três eu conferi e estão CORRETOS). Para os outros cinco, ou voltar a
`ready` com motivo próprio, ou criar uma categoria que diga a verdade — algo como
`shared-repository`: "o repositório é um só e a conversão das leituras é atômica com a dos três
domínios varridos".

---

### A-02 · MEDIUM · O portão não consegue detectar uma classificação errada — o modo de falha que este commit corrige pode voltar amanhã

**Evidência.** `scripts/check-rls-coverage.ts:118-134` (`classificationFindings`) verifica três
coisas: que todo pendente tem linha, que o motivo tem ≥ 20 caracteres, e que nenhuma linha aponta
para domínio inexistente ou já migrado. A `category` em si nunca é confrontada com o código.

**Causa.** A classificação é texto mantido à mão. Foi exatamente por isso que ela ficou otimista até
este commit.

**Impacto.** O achado de que o autor mais se orgulha (11 domínios estavam errados) foi produzido por
leitura humana, e nada impede que a próxima sessão devolva um domínio para `ready` e passe no portão.
O portão mede *que existe uma classificação*, não *que ela é verdadeira*.

**Reprodução (F7).** Trocar `studio_policy_audit` para `category: 'ready'` mantendo o texto:
`npx tsx scripts/check-rls-coverage.ts --self-test` → `RLS_COVERAGE_SELF_TEST=PASS checks=6`,
`RLS_COVERAGE=PASS migrados=2/26`, saída só muda no resumo (`ready=1`).

**Correção sugerida.** Ancorar cada motivo em prova executável, no mínimo para `startup-reconciliation`
e `cross-tenant-invariant`: uma entrada extra `evidence: { file, symbol }` e uma conferência de que o
símbolo citado (`reconcileInterruptedExecutions`, `#performRestartReconciliation`,
`reconcileInterruptedTeams`, `verifyPolicyAuditChain`) ainda existe naquele arquivo. Hoje as
referências `service.ts:311`, `service.ts:480`, `service.ts:201` nos motivos são apenas texto e vão
envelhecer em silêncio.

---

### A-03 · MEDIUM · Caminho RLS lê a tabela inteira de eventos do inquilino a cada linha de auditoria

**Evidência.** `plugins/integration-hub/src/service.ts:1562-1568` — `#audit()` grava o evento e
chama `#retainEvents()`. `service.ts:1577-1580` — `#retainEvents()` chama `eventCount(actor)` e, se
passar do teto, `pruneEvents(actor, 1000)`. No repositório RLS,
`plugins/integration-hub/src/tenant-repository.ts:157-159` implementa `eventCount` como
`(await this.#events(scope)).length`, e `#events()` (`tenant-repository.ts:180-183`) faz
`store.list(...)` — que em `plugins/storage-postgres/src/tenant-store.ts:83-92` é
`SELECT key, value ... ORDER BY key`, ou seja, traz **o valor JSON de todos os eventos** — depois
`.map().filter().sort()`.

**Causa.** A porta do armazenamento por inquilino não oferece `COUNT` nem `ORDER BY ... LIMIT`. O
comentário do arquivo (`tenant-repository.ts:23-27`) reconhece isso para a *paginação*, mas não para
a *contagem*, que é o caminho quente de verdade: paginação é uma tela, contagem é **toda ação
auditada**.

**Impacto.** Com `EVENTS_RETAINED_PER_TENANT = 1000` (`service.ts:150`), cada chamada de integração,
cada aprovação e cada recusa paga uma transação com até ~1000 linhas JSON materializadas, mais um
`sort` de 1000 itens em memória — só para comparar um número. `events()` faz o mesmo para devolver
50 linhas. É custo e latência, não vazamento; mas é uma amplificação nova, criada por este commit, no
caminho que o commit apresenta como o mais seguro.

**Reprodução.** Leitura direta; não há teste de contagem de idas ao banco. `service.spec.ts` usa um
`MemoryRepository` próprio, então o custo não aparece em nenhuma suíte.

**Correção sugerida.** Ou acrescentar `count(scope, unit, table)` e `listPage(..., order, limit)` à
interface `HubTenantRecordStore` (a tabela já é indexada por `(org_id, tenant_id, unit, table_name, key)`),
ou trocar `#retainEvents` por retenção amortizada (podar a cada N escritas, ou por marca de tempo)
para deixar de pagar a varredura por evento. Enquanto isso não existir, o comentário do arquivo
deveria dizer também que a CONTAGEM é uma varredura por evento — hoje ele só fala da paginação.

---

### A-04 · MEDIUM · A "segunda tranca" só está provada para integrações; em exportações e eventos ela é código morto do ponto de vista dos testes

**Evidência.** `tenant-repository.ts:94-101, 133-141, 180-183` aplicam `#inScope` em cinco lugares.
`plugins/integration-hub/tests/tenant-repository.spec.ts:115-124` prova a tranca apenas para
`integration()`/`integrations()`.

**Causa.** O duplo `store` de teste imita o comportamento do banco (só devolve o escopo pedido), o que
é a decisão certa e está bem documentada na spec. Mas isso significa que qualquer `filter` do
repositório é redundante *no teste*, e só um caso força a divergência entre o escopo da consulta e o
escopo gravado no corpo da linha.

**Impacto.** Removi o `#inScope` de `exports()` e de `#events()` (F5) e removi a conferência
`value.project_id !== projectId` de `export()` (F4): **os 11 testes continuam passando nas duas
mutações**. Pior: o teste "a exportação é achada pelo projeto, e não por outro projeto com o mesmo
identificador" (`tenant-repository.spec.ts:186-196`) afirma no nome exatamente o que F4 quebra, e não
o percebe — ele prova que a CHAVE carrega o projeto (`exportKey`), não que o valor é reconferido.
É um teste que prova a coisa errada.

**Reprodução.** F4 e F5 acima.

**Correção sugerida.** Três casos, no mesmo molde do que já existe para integrações: uma exportação
semeada com `tenant_id` divergente no corpo; uma exportação semeada sob a chave `p1/e1` mas com
`project_id: 'p2'` no corpo (só isso mata F4); um evento com `org_id` divergente no corpo.

---

### A-05 · LOW · Em modo `rls` o índice da chave-valor continua sendo montado inteiro, com todos os inquilinos, em memória

**Evidência.** `plugins/integration-hub/src/index.ts:326-336` (`hubRepository`) sempre constrói
`new DomainHubRepository(domain.table('integrations'), domain.table('exports'), domain.table('events'), switchDomain.table('switches'))`
e, no ramo `rls`, passa esse objeto como fonte dos desligamentos por alcance. O construtor
(`index.ts:78-99`) percorre `integrationTable.entries()`, `exportTable.entries()` e
`eventTable.entries()` e monta os três índices por escopo.

**Causa.** O `TenantRecordHubRepository` só precisa de `killSwitch`/`putKillSwitch`/`killSwitches`
(`tenant-repository.ts:59`), que vêm de `switchDomain` — outro domínio.

**Impacto.** Nenhum vazamento (nada consulta esses índices no ramo RLS), mas a promessa do título —
"o Hub sai da chave-valor" — é meia-verdade: a unidade opaca continua aberta e integralmente
residente, com integrações, exportações e eventos de todos os inquilinos na memória do processo. É
superfície e memória que o desenho diz ter eliminado.

**Reprodução.** Leitura de `index.ts:78-99` e `index.ts:326-336`.

**Correção sugerida.** Separar a fonte dos desligamentos numa classe própria que receba só
`switchTable`, e passar essa classe ao `TenantRecordHubRepository`. O ramo `kv` continua usando o
`DomainHubRepository` completo.

---

### A-06 · LOW · No caminho de ESCRITA o escopo vem do corpo do registro, não do ator — o banco nunca tem como recusar

**Evidência.** `tenant-repository.ts:103-107, 120-129, 143-148, 161-165`: `putIntegration`,
`compareAndSwapIntegration` (no `put`), `putExport` e `putEvent` montam o escopo como
`{ orgId: value.org_id, tenantId: value.tenant_id }`.

**Causa.** A interface `HubRepository` (`service.ts:55, 68, 72`) nunca passou ator nas escritas — é
desenho herdado da chave-valor.

**Impacto.** A frase do arquivo, "o PostgreSQL recusa o que não é do inquilino, sem depender de nenhum
`filter` deste arquivo estar correto" (`tenant-repository.ts:12-14`), vale para LEITURA. Para escrita
o `set_config` é alimentado pelo próprio valor, então a política RLS concorda com qualquer coisa que
o produto tenha montado: quem garante o escopo continua sendo o serviço. Conferi todos os chamadores
(`service.ts:438, 1068, 1107, 1384, 1563`) e todos derivam `org_id`/`tenant_id` do `actor` ou de um
registro lido sob escopo — **hoje está correto**. É defesa em profundidade ausente, não bug.

**Correção sugerida.** Ou passar `scope` explícito nas escritas e conferir contra o corpo antes do
`put`, ou registrar no comentário do arquivo que a garantia de banco é assimétrica (leitura sim,
escrita não). A segunda é barata e evita que a frase seja lida como mais forte do que é.

---

### A-07 · LOW · `exportKey` é uma invariante de comentário, não de código

**Evidência.** `tenant-repository.ts:67-77`: *"O separador é uma barra porque nenhum dos dois
identificadores a contém"*. Não há asserção. `project_id` é `z.string().min(1)`
(`plugins/prompt-to-app/src/model.ts:25`) e chega até aqui vindo da URL:
`plugins/integration-hub/src/http.ts:185-187` casa `/^\/projects\/([^/]+)\/exports/` e depois faz
`decodeURIComponent`, então `%2F` vira `/` de verdade. `assertKey` no banco
(`plugins/storage-postgres/src/tenant-store.ts:330-333`) aceita `/` sem reclamar.

**Impacto.** A LEITURA está protegida: `export()` reconfere `value.project_id !== projectId`
(exceto que essa conferência não é testada — A-04), e `listExports`/`exportRecord` chamam
`this.options.projects.project(actor, projectId)` (`service.ts:1148, 1391`), que rejeita projeto
inexistente. A ESCRITA não tem essa rede: se algum dia `project_id` ou `export_id` puder conter `/`
(hoje ambos são `randomUUID`, `prompt-to-app/src/service.ts:59, 82`), duas exportações diferentes
colidem na mesma chave e uma sobrescreve a outra em silêncio, deixando o arquivo em disco órfão.
Probabilidade baixa; custo de blindar, uma linha.

**Correção sugerida.** `if (projectId.includes('/') || exportId.includes('/')) throw new Error(...)`
dentro de `exportKey`, ou codificar os dois segmentos com `encodeURIComponent`.

---

### A-08 · LOW · Escritas de evento perderam a fila que o repositório de chave-valor tem

**Evidência.** No KV, `putEvent` e `pruneEvents` rodam sob `#exclusiveEvent`
(`plugins/integration-hub/src/index.ts:141-167`). No RLS, `putEvent`
(`tenant-repository.ts:161-165`) e `pruneEvents` (`tenant-repository.ts:167-174`) não passam por
fila nenhuma — `#exclusive` só cobre as escritas de integração.

**Causa.** Sem índice em memória, `putEvent` é uma escrita única e de fato não precisa de fila.
`pruneEvents` precisa menos do que parece: ele tira um retrato ordenado e apaga a CAUDA, então um
evento novo concorrente (que entra na cabeça) nunca é apagado por engano. Conferi.

**Impacto.** Não há perda de evento. O que há é contagem: duas podas concorrentes do mesmo inquilino
apagam o mesmo conjunto e cada uma devolve `removed.length` como se tivesse apagado — o número
devolvido por `pruneEvents` deixa de ser o número de linhas efetivamente removidas (`store.delete`
devolve `boolean` e o retorno é descartado, `tenant-repository.ts:172`). `#retainEvents` também tem
uma janela entre `eventCount` e `pruneEvents` que a versão síncrona não tinha; a consequência é uma
poda a mais, nunca uma a menos.

**Correção sugerida.** Somar apenas os `delete` que devolveram `true`, e — se o número importar para
alguém — colocar `pruneEvents` na fila `#exclusive` (ou numa fila própria de eventos, para não
serializar poda com troca condicional).

---

### A-09 · LOW · A contagem do próprio commit não fecha (corrigida 5 minutos depois)

**Evidência.** A mensagem de `ad004c2` diz *"O mapa agora diz: `ready=1`,
`startup-reconciliation=10`, `cross-tenant-invariant=2`, `hot-guard=4`, `tenant-resolution=6`,
`needs-review=2`"* — soma 25. O portão executado no mesmo commit imprime
`pendentes=24` e `cross-tenant-invariant=2 hot-guard=4 needs-review=2 startup-reconciliation=10
tenant-resolution=6`, **sem `ready`**. O `ready=1` era `studio_integrations`, que o mesmo commit
migrou e portanto removeu de `PENDING_CLASSIFICATION`. O título ("os 25 restantes") também está um a
mais.

**Impacto.** Documental. `28bb1b4` corrige o livro-razão para `ready=0` e cobertura 2/26; a mensagem
de commit fica errada no histórico.

---

### A-10 · FALSO-POSITIVO · `configureSmtp` concorrente NÃO duplica o registro de SMTP

**Hipótese que eu levantei.** `configureSmtp` (`service.ts:1082-1113`) é o único caminho de escrita de
integração que **não** passa por `#exclusiveIntegration` (compare com `service.ts:410, 556, 618, 1046`).
Entre `const existing = await this.#smtpRecord(actor)` (`service.ts:1101`, antes síncrono) e
`await putIntegration(record)` (`service.ts:1107`) passou a existir uma suspensão que não existia,
o que abriria janela para duas chamadas lerem `undefined` e criarem dois registros de SMTP.

**O que eu fiz.** Escrevi uma spec descartável (`zz-audit-probe.spec.ts`, removida) que instancia o
`IntegrationHubService` REAL contra o `TenantRecordHubRepository` REAL, com um armazenamento
por inquilino em memória cujo `put` é genuinamente assíncrono, tira dois bilhetes de confirmação e
dispara dois `configureSmtp` em `Promise.all`.

**Resultado.** `SMTP RECORDS = 1`. Uma das duas chamadas é recusada em `#requireTier`
(`service.ts:1490`) — a autoridade de confirmação já serializa a operação. **Não é achado.**

**Efeito colateral útil.** A sonda mostrou que o serviço roda de ponta a ponta contra o repositório
RLS sem nenhum ajuste — o que é uma boa notícia para o item 1 do placar.

---

## O que está CORRETO (conferido, não presumido)

- **Conversão síncrono → assíncrono, sem promessa solta.** Varri todos os chamadores de `list`,
  `searchIntegrations`, `health`, `smtp`, `listExports`, `exportRecord` e `events` em
  `plugins`, `apps`, `scripts` e `tests`: **todos** aguardam. `http.ts:116, 175, 188, 191, 221` foram
  convertidos, `publicExport` virou `Awaited<ReturnType<...>>` (`http.ts:257`), e os dois consumidores
  externos do Hub (`plugins/emergency-stop/src/index.ts:93` e `plugins/mcp-client/src/index.ts:98`)
  só tocam superfícies que continuam síncronas (`cancelScope`, `callPolicy`,
  `useMcpDispatcher`). `npx tsc --noEmit` = 0.
- **Nenhuma leitura perdeu escopo na conversão.** Toda chamada a `repository.integration(s)`,
  `export(s)` e `eventPage`/`eventCount` recebe o `actor` do pedido; não achei um só caso de ator
  trocado, capturado de fora ou reaproveitado.
- **Corridas leitura→escrita.** `setEnabled`, `removeIntegration`, `registerIntegration` e
  `#recordCall` rodam inteiros dentro de `#exclusiveIntegration(this.#scope(actor), ...)`
  (`service.ts:410, 556, 618, 1046`; fila por escopo em `service.ts:713-721`), então o `await`
  novo não abriu interleaving dentro do escopo. E, mesmo se abrisse, a escrita final de
  `#setEnabled` é `compareAndSwapIntegration` com impressão digital (`service.ts:585`), com uma
  segunda fila no repositório (`tenant-repository.ts:196-200`) — F2 prova que essa fila é necessária
  e que o teste a cobre.
- **`pruneEvents` corta a cauda, não a cabeça.** `rows` vem ordenado do mais novo para o mais velho
  (`newestFirst`, `tenant-repository.ts:62-65`) e `slice(Math.max(keep, 0))` descarta os antigos;
  o `Math.max(keep, 0)` protege contra `keep` negativo. F3 prova que o teste morre se isso inverter.
- **`hubRepository()` falha alto.** `index.ts:326-336`: padrão `kv`, `HUB_TENANT_STORAGE_UNAVAILABLE`
  quando `rls` é pedido sem `studioTenantStorage`. Segue exatamente o precedente já aprovado em
  `plugins/action-approval/src/plugin.ts:183-191`, inclusive no nome do erro.
- **A corrente de hash da política é GLOBAL — a reclassificação está certa.**
  `plugins/policy/src/index.ts:414-425`: um único `head` de processo, `seq` monotônico sobre TODAS as
  entradas, e `verifyPolicyAuditChain` (`policy/src/index.ts:127-149`) exige `record.seq === index`
  sobre o conjunto inteiro, alimentado por `[...decisions.entries()]` (`index.ts:432`). Uma política
  por linha por inquilino torna a verificação impossível. `cross-tenant-invariant` é a categoria certa.
- **As três varreduras de início existem, são sem escopo, e ESCREVEM.**
  `plugins/prompt-to-app/src/service.ts:311-353` lê `runs()`/`projects()` sem ator e grava `putRun`,
  `putApproval` e `putProject`; `plugins/agents/src/service.ts:480-518` lê `repository.runs()` e
  `repository.leases()` sem ator e grava `putRun`/`putLease`;
  `plugins/agent-team/src/service.ts:201-232` lê `tasks()`/`teams()`/`agents.runs()` sem ator e grava
  `putTask`/`putTeam`. A categoria nova é honesta, e é honesto dizer que a saída é desenho.
  (O que não é honesto é aplicá-la a cinco domínios que a varredura não toca — A-01.)
- **Teto do `hub-binding`.** 3 s contra uma ferramenta de 30 s continua medindo o teto do Hub e não a
  ferramenta; o motivo (o `spawn` e o aperto de mão do MCP moram dentro do orçamento na PRIMEIRA
  chamada) está escrito no teste. Correto.
- **`RLS_MIGRATED` não pode encolher nem mentir sobre o arquivo.** `coverage()`
  (`check-rls-coverage.ts:189-215`) confere domínio existente, arquivo existente, sem repetição e
  piso — e o self-test cobre os quatro. O que ele não confere é a `category` (A-02).

## Nota sobre o número `migrados=2/26`

O portão imprime `2/26` e o cabeçalho do arquivo diz *"Os domínios que JÁ saíram da chave-valor
opaca"*. Nenhuma instalação usa RLS hoje: `storageAuthority` é `kv` por padrão nos dois plugins
migrados. O livro-razão **é honesto sobre isso** (`docs/MASTER_REQUIREMENTS_LEDGER.md`, S-09: *"Nenhum
perfil define `tenantRuntimeDsnRef`, entao nenhuma instalacao usa RLS hoje"*), então não é um achado —
mas a linha de saída do portão, lida sozinha, diz mais do que é verdade. Sugestão: imprimir
`migrados=2/26 (caminho disponivel; padrao continua kv)`.

## Higiene

Mutações F1–F7 restauradas com `git checkout --`; sonda F8 (`zz-audit-probe.spec.ts`) removida.
`git status --porcelain` ao final mostra apenas `?? apps/studio-web/tests/auditor-c-pending.spec.ts`,
que **não é meu** (é de outro auditor rodando em paralelo) e por isso foi deixado intacto. Nada foi
commitado, empurrado, apagado ou implantado; `third_party/` e `plugins/*/lib/**` não foram tocados.
