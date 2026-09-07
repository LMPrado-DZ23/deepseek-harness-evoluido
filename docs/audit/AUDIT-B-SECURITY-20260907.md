# Auditoria B — Security / DevSecOps
**Objeto:** `/home/claude/integ`, `HEAD = dba2787`, base `f1677b4` (M89).
**Postura:** revisão ofensiva. Tudo que afirmo como quebrado ou como sólido foi lido no código e, onde possível, **provado por execução** (vitest fora do repositório, em `/tmp/auditB`, e PostgreSQL 16 real).
**Regra dura respeitada:** nenhuma escrita em `/home/claude/integ`. Único arquivo criado: este.

---

## VEREDITO: `GO_LIMITED`

Não encontrei nenhuma falha explorável introduzida por este candidato. As quatro superfícies de acesso que entraram (conversa do assistente, identidade, autoridade de aprovação, alvo do `pg_dump`) resistiram a todos os ataques que consegui montar, e várias delas **fecham** buracos que existiam em M89 (rota pública `/bind-agent` removida, cliente do Harness fechado no servidor, borda Caddy passando a devolver 404 para tudo que não é Studio).

O `GO` é **limitado** por duas coisas, nenhuma delas uma vulnerabilidade nova:

1. `plugins/action-approval` é **superfície morta**: nada monta `/studio/approvals`, ninguém chama `request()`, e não existe implementação de produção de `authenticate`/`assertCsrf`. O portão T2/T3 que de fato roda hoje continua sendo um `approved: true` fabricado no servidor. Este candidato **não entrega** a garantia de confirmação humana que o commit anuncia — entrega a biblioteca que a implementaria.
2. A chave do limitador de taxa da identidade vem de `X-Forwarded-For`, que é do cliente (MEDIUM, pré-existente, hoje contido pelo `rate_limit` do Caddy).

**Contagem:** CRITICAL 0 · HIGH 0 · MEDIUM 2 · LOW 5 · INFO 1.

---

## Tabela de achados

| # | Sev | Arquivo:linha | Ataque | Evidência / reprodução | Correção |
|---|-----|---------------|--------|------------------------|----------|
| B-1 | MEDIUM | `plugins/action-approval/src/http.ts:5`; `plugins/assistant-bridge/src/service.ts:153,189` | **A autoridade de confirmação não protege nada.** O cliente não decide nível/ação/sujeito porque *ninguém* decide: o fluxo não existe em produção. E o portão que roda de verdade recebe `approval: { approved: true, tier, approvedBy: principal.userId }` fabricado pela ponte, com `tier` derivado do argumento `sensitive` da própria chamada de ferramenta. | `grep -rn "handleApproval\|routeApproval\|StudioActionApprovalService" plugins apps scripts \| grep -v node_modules \| grep -v ^plugins/action-approval/` → só `plugins/staging/src/approval-adapter.ts` (que consome, nunca cria) e os gates de domínio. `grep -rn "studio/approvals" apps plugins scripts` → só a própria constante. `StagingService` nunca chama `request()`. | Montar `routeApproval`/`handleApproval` no `createStudioWebHandler` com `authenticate = authenticatedMutation` e `assertCsrf = validateCsrfToken`, declarar as três rotas num `StudioRouteContract`, e fazer `StudioAgentService.start` exigir um `ApprovalReceipt` consumido em vez de um `DelegationApproval` acreditado. Enquanto isso, **não contar M90/M72 como entregue**. |
| B-2 | MEDIUM | `plugins/identity/src/http.ts:99-102` + `plugins/identity/src/rate-limit.ts:62-71` | **O cliente escolhe o próprio balde de limite de taxa.** Com `edgeRequired`, a chave é `x-forwarded-for.split(',')[0]` — e o Caddy *acrescenta* o IP real ao fim da cadeia, então o primeiro elemento é o valor que o atacante enviou. Variar o XFF a cada tentativa zera o contador de `/magic/verify` e `/magic/start` na camada da aplicação. | Provado em `/tmp/auditB/ratelimit.spec.ts`: `rateLimitKey` com XFF `1.1.1.1 / 2.2.2.2 / 3.3.3.3 / 1.1.1.1` produz **3 chaves distintas**, nenhuma igual à chave do IP real. `NÃO VERIFICADO` de ponta a ponta: não subi o Caddy nesta caixa; a conclusão sobre o *append* vem do comportamento documentado do `reverse_proxy`. Mitigação real hoje: `deploy/caddy/DZ23.common.caddy:14-47` limita por `{remote_host}` (5/15m em magic/start, 300/min global), o que contém o abuso na borda. | Usar o **último** elemento do XFF (o que o proxy confiável acrescentou), ou o `remote_host` do socket quando o par é o proxy conhecido. Nunca o primeiro. |
| B-3 | LOW | `plugins/storage-postgres/src/dsn.ts:160-168` | **Alvo misturado no backup de segurança.** `applyTargetEnvironment` só escreve `PGDATABASE` quando o DSN tem caminho. Um DSN sem banco (`postgresql://u@host:5432/`) sobrescreve `PGHOST`/`PGPORT`/`PGUSER` mas deixa o `PGDATABASE` do ambiente do operador — exatamente o cenário de "o backup sai do banco ERRADO e o restore destrutivo segue confiando nele" que o comentário do commit diz ter fechado. | `/tmp/auditB/pgdump.spec.ts`: `postgresToolConnection('postgresql://alguem@127.0.0.1:5432/', 'off', { PGDATABASE: 'banco_do_operador', PGHOST: 'outro.host' })` → `{"PGDATABASE":"banco_do_operador","PGHOST":"127.0.0.1","PGPORT":"5432","PGUSER":"alguem"}`. | Recusar o DSN sem `dbname` em `postgresDumpInvocation`, ou `delete env.PGDATABASE` quando o DSN não nomeia um banco. Meia herança é pior que nenhuma. |
| B-4 | LOW | `plugins/storage-postgres/src/dsn.ts:161` | **Host IPv6 quebra o backup obrigatório.** `url.hostname` devolve `[::1]` com colchetes; o libpq não aceita colchetes em `PGHOST`. O `pg_dump` nunca conecta, o backup de segurança falha e o restore aborta. | `postgresToolConnection('postgresql://alguem@[::1]:5432/db','off').env.PGHOST === "[::1]"` e, com psql real: `PGHOST='[::1]' psql -c 'select 1'` → `could not translate host name "[::1]" to address`. Falha **fechada** (o restore destrutivo não prossegue), por isso LOW. | `host.replace(/^\[|\]$/g, '')` antes de escrever `PGHOST`. |
| B-5 | LOW | `plugins/storage-postgres/src/restore.ts:985-988` | **Regex de saneamento do diagnóstico é perdedora com strings em forma de URI.** `(\/[^\s:]+)+` → último segmento transforma `postgresql://u:senha@h/db` em `postgresql:u:senha@hdb`: a senha **sobrevive**. | Verificado com PostgreSQL 16 real: o `stderr` de autenticação falha é `pg_dump: error: connection to server at "127.0.0.1", port 5432 failed: FATAL: password authentication failed for user "dz23_test"` — **sem senha**. Logo, hoje não é explorável. `NÃO VERIFICADO`: não achei mensagem do pg_dump 16 que ecoe um conninfo com senha. | Redigir o diagnóstico contra `env.PGPASSWORD` explicitamente (substituição literal) antes de recortar caminhos, em vez de confiar que a mensagem nunca cita segredo. |
| B-6 | LOW | `plugins/studio-web/src/index.ts:154-170` | **TOCTOU e symlink intermediário no servidor estático.** `lstat` e depois `readFile`: o alvo pode ser trocado entre os dois. E só o **último** componente é checado contra symlink — `dist/link/passwd` com `link` sendo symlink passa por `safeTarget` (`resolve` não segue links) e é servido. Pré-existente, exige escrita local em `distDirectory`. | Leitura de código. `NÃO VERIFICADO` por execução: não montei symlink dentro do repo (regra de somente-leitura) e o cenário exige o atacante já escrevendo no diretório do build. | Abrir com `open(path, O_NOFOLLOW)` e `fstat` no **mesmo** descritor, ou `realpath` o alvo e reconfirmar o prefixo. |
| B-7 | LOW | `plugins/studio-web/src/assistant-session.ts:58,120-129` | **Recursos órfãos.** `#activeByIdentitySession` cresce por sessão de dispositivo e só encolhe em `#release`. E quando `sessions.create` devolve um preset diferente (`SESSION_CONFLICT`, linha 121), a sessão do Harness já criada **não** é liberada. | Leitura de código; nenhuma das duas é caminho de acesso. A cota `MAX_HARNESS_SESSION_BINDINGS = 8` **não** vira DoS porque a lista só cresce quando todas as conversas vivas morreram (verificado em `#existingSession`). | Evicção por LRU/TTL no mapa e liberar a sessão criada no braço de `SESSION_CONFLICT`. |
| B-8 | INFO | `plugins/storage-postgres/src/restore-policy.ts:99` | `--schema=<x>` é **padrão**, não literal, no `pg_dump`. Com `*` o backup vira o banco inteiro. | Provado com PG real: `--schema=public` → 1.253 bytes; `--schema=*` → **2.060.446 bytes**. **Não é alcançável**: `restore.ts:167` chama `assertConfiguredSchemaName`, que aplica `/^[a-z][a-z0-9_]*$/`. Registrado como defesa em profundidade, não como achado. | Manter a validação onde está; se algum caller novo pular `assertConfiguredSchemaName`, o buraco abre. |

---

## Resposta a cada superfície

### 1. Autorização e escopo multi-inquilino — **SÓLIDA (provado)**

**Conversa (`studio-web`).** Montei o handler HTTP real (`createStudioWebHandler`) sobre um `StudioIdentityService` real, com duas pessoas (`user-a`, `user-b`) **na mesma organização e no mesmo inquilino** — o caso mais difícil, porque nenhum limite de tenancy ajuda. A pessoa A abriu a conversa; a B tentou as três operações com o id dela:

```
A lê:                       200  {"conversation_id":"conv-id-6", ...}
B lê conversa de A:         404  {"error":"Conversa não encontrada."}
B escreve na conversa de A: 404  {"error":"Conversa não encontrada."}
B cancela a conversa de A:  404  {"error":"Conversa não encontrada."}
```

A razão está em `StudioIdentityService.ownsHarnessSession` (`service.ts`): exige **exatamente um** vínculo (`bindings.length !== 1` → recusa, então ambiguidade falha fechada), que esse vínculo seja **da mesma sessão de dispositivo** (`session_id`), que a sessão esteja utilizável, e que usuário/org/inquilino batam. É mais estrito que IDOR entre pessoas: nem uma **segunda sessão da mesma pessoa** alcança a conversa. `bindHarnessSession` recusa (`IdentityError('replay')`) vincular uma conversa já vinculada a outra sessão, então não dá para "adotar" a conversa alheia — e a rota que permitia isso, `POST /bind-agent`, **foi removida** neste candidato (`http.ts`, contrato retirado de `IDENTITY_ROUTE_CONTRACTS`). Essa remoção é a melhor coisa de segurança do lote.

**Aprovações (`action-approval`).** `#owned` (service.ts:210-223) compara os quatro eixos e devolve `NOT_FOUND` para todos. Provado com vizinhos em cada eixo, nas três operações:

```
get/confirm/deny × {outro usuário, outra sessão do MESMO usuário, outra org, outro inquilino} = NOT_FOUND (12/12)
estado do registro depois do ataque = PENDING (nada foi movido)
```

**Replay.** `consume` é idempotente **só** para a reivindicação exata: repetir `claimId: 'rel-1'` devolve o mesmo recibo (`OK`); `rel-2` sobre a mesma confirmação → `CONSUMED`. Uma confirmação vale por uma ação, com escrita condicionada ao estado (`put(record, 'AVAILABLE')`) e reconferência do vencedor na corrida.

**Expiração.** TTL de 3 min: `consume` após o prazo → `EXPIRED`, e o registro fica `EXPIRED` no repositório (não reabre).

### 2. O cliente decide o que não deveria — **SÓLIDA na superfície nova; ver B-1**

Varri os caminhos novos atrás de nível, ação, sujeito, fingerprint, `approved`, org e inquilino vindos do cliente:

- `handleApproval` (http.ts:58-77): o corpo é **lido e descartado** com teto de 4 KiB (`drainBody`). Nada dele chega ao serviço. Provei enviando `{"approved":true,"tier":"T3","user_id":"user-b"}` num `POST .../confirm` legítimo: a resposta continua `tier: "T2"`, `state: "AVAILABLE"`, com o escopo da sessão. O ator vem inteiro de `config.authenticate(request)`.
- Não existe rota que **crie** aprovação: `routeApproval` só conhece `read`/`confirm`/`deny`, e método trocado vira `method-not-allowed`, nunca outra ação.
- **Rebaixamento de nível fechado:** um pedido T3 não confirmado, consumido como `tier: 'T2'`, dá `FORBIDDEN` (o `matches` em `consume` compara `tier` junto com ação, sujeito e fingerprint). E `confirm` de T3 sem passkey dá `STRONG_IDENTITY_REQUIRED` **sem** consumir o pedido.
- No staging (`service.ts:452-470`), o cliente só diz **qual** aprovação (`approvalId`); `tier` é literal `'T2'`, `subjectId` é o `operation_id` reservado e `fingerprint` é calculado no servidor. Um cliente não consegue apontar uma aprovação T3 e usá-la.
- `assistant-http.ts:115-128`: o corpo de `/messages` aceita **exatamente uma** chave, `text`, string. Qualquer outra forma → 400.
- **A exceção é B-1**: `assistant-bridge/src/service.ts:153` monta `approval: { approved: true, tier, approvedBy: principal.userId }` — o `approved` é fabricado e o `tier` sai do argumento `sensitive` da chamada de ferramenta. É pré-existente a `f1677b4` (`git log -S` aponta `8140088`), **não é regressão**, e `NÃO VERIFICADO` se a camada de aprovação do Harness (`approval/asked`) cobre esse ponto na prática. Mas é exatamente o buraco que a autoridade nova existiria para tapar, e ela não está ligada.

### 3. CSRF, host e origem — **SÓLIDA (provado)**

`createStudioWebHandler` chama `assertRequestTrust` **antes** de rotear, e `handleAssistantConversation` chama `authenticatedMutation`, que exige o cabeçalho `x-dz23-csrf` em todo método que não é GET/HEAD. Contra o servidor real:

```
POST sem CSRF                       → 401
POST com CSRF errado                → 401
POST com Origin: https://mal.example → 401
POST com Host: mal.example (http.request, setHost:false) → 401
POST com x-dz23-csrf repetido (dois valores) → 401
```

O cabeçalho repetido morre em `singleHeader` (`http.ts:351`), que devolve `undefined` para array com mais de um elemento em vez de escolher uma cópia — o mesmo tratamento vale para `content-type`, `host`, `origin` e `x-dz23-edge`. O token CSRF é derivado de `token_hash` (`csrfTokenFor`) e comparado com `timingSafeEqual` sobre digests; o cookie CSRF é explicitamente **zerado** (`serializeSessionCookies`), então não há double-submit para roubar — só o cabeçalho, que origem estrangeira não consegue ler. `assertEdgeTrust` compara o segredo de borda com `timingSafeEqual`.

Ponto observado, não achado: `assertRequestTrust` só checa `Origin` em métodos que não são GET. O `GET .../events` devolve JSON sem cabeçalho CORS, então página estrangeira não lê a resposta; e `/studio` sai com `X-Frame-Options: DENY` e CSP `frame-ancestors 'none'`.

Na borda, `deploy/caddy/DZ23.common.caddy:72-87` passou a listar `@studio_surface path /studio /studio/* /api/studio/*` com `forward_auth`, e **tudo o mais responde 404**. O `prove-edge.mjs` foi reescrito para afirmar isso (`/`, `/api/edge-proof`, `ws /api/remote.mux` → 404, e `/api/studio/identity/harness/session` → **403**). É um estreitamento real de superfície.

### 4. Travessia e injeção — **SÓLIDA**

- `routeAssistantConversation` (assistant-http.ts:44-55) fatia o **path bruto** por `/` e só depois faz `decodeURIComponent` do primeiro segmento: `%2f` não vira separador (a `URL` do Node não decodifica `%2F` no `pathname`), e o regex `^[A-Za-z0-9_.:-]{1,128}$` mais a recusa de id só-pontos matam o resto. Ainda que um `..a` passasse pelo regex, ele **não chega** a lugar nenhum: `#assertOwned` roda antes de `sessions.inspect`, e só ids que o servidor criou e vinculou passam.
- `routeApproval` exige `^apv-[a-f0-9]{64}$` — é o digest, não há string livre.
- SQL: as consultas novas usam parâmetros (`$1..$4`); todo nome de esquema/identificador passa por `quoteIdentifier`/`assertIdentifier` (`^[a-z][a-z0-9_]*$`) e o esquema de restore por `assertConfiguredSchemaName` **antes** de virar `--schema=`. O `attemptId`, que entra em nome de arquivo do diário, é validado por `^[a-zA-Z0-9_-]{8,80}$`. Sem travessia.

### 5. Vazamento — **SÓLIDA (provado)**

Alimentei o journal do Harness com um evento `compaction/summary` carregando `summary`, `rawOutput`, `provider`, `model`, `usage`, `maxTokens`, e um `compaction/end` com `error` contendo caminho absoluto. Resposta HTTP real:

```json
{"conversation_id":"conv-id-6","cursor":3,"events":[
 {"type":"message.user","seq":1,"at":1,"id":"m1","text":"segredo do A","truncated":false},
 {"type":"compaction.state","seq":2,"at":2,"compaction_id":"c1","state":"committing","items":1,"tokens":42},
 {"type":"compaction.state","seq":3,"at":3,"compaction_id":"c1","state":"failed"}],
 "truncated":false}
```

Nenhum de `RAW_OUTPUT_VAZADO`, `RESUMO INTERNO`, `anthropic`, `claude-opus-4`, `/home/claude`, `maxTokens` aparece. Do `compaction/end` atravessa só a **presença** do erro, virando `state: "failed"`. `sanitizeAssistantEvent` é uma lista de permissão por tipo: o que não casa é **descartado**, não repassado.

Outros caminhos: `AssistantConversationService.snapshot` engole qualquer erro do upstream num `NOT_FOUND` catalogado; `index.ts:106-110` passou a mandar `t('assistant.interfaceUnavailable')` para erro inesperado, deixando passar só `IdentityError` e `StaticFileError`, cujas mensagens são todas constantes ("Caminho inválido.", "Links simbólicos não são servidos.") — nenhuma interpola caminho. O `publicView` do `action-approval` **não** devolve `fingerprint` (conferido: o corpo da resposta não contém o valor). Os catálogos `pt-BR.json` novos (identity e studio-web) não têm nada sensível. O único ponto que cita id em texto é a linha de auditoria de `releaseHarnessSession`, que é interna e cita um id de conversa, não um segredo.

### 6. Segredos — **SÓLIDA (provado com PostgreSQL real)**

Executei o `pg_dump` real com a invocação que o produto monta e li o `/proc/<pid>/cmdline` do filho:

```
ARGV     = ["pg_dump","--schema=public","--format=custom"]
cmdline  = "/usr/bin/perl\0/usr/bin/pg_dump\0--schema=public\0--format=custom\0"
código   = 0, bytes = 1253 (dump real do dz23_test)
env      = PGSSLMODE, PGCONNECT_TIMEOUT, PGPASSWORD, PGHOST, PGPORT, PGUSER, PGDATABASE
```

Senha, host, porta, usuário e banco ficam **só** no ambiente do filho — `ps` não vê nada. E a correção deste candidato é real: a linha antiga `environment: { ...target.env, PGDATABASE: target.dsn }` punha a URI inteira como nome de banco; agora `applyTargetEnvironment` decompõe. Provei que o alvo é o certo (dump não vazio do `dz23_test`).

Com senha errada, o diagnóstico novo (`pgDumpDiagnostic`) recebe do PG 16: `connection to server at "127.0.0.1", port 5432 failed: FATAL: password authentication failed for user "dz23_test"` — sem senha. O CLI de restore/backup recebe o DSN por **referência de variável** (`--dsn-ref`), nunca em `argv`, e sanitiza o erro com `sanitizeOperatorError(error, [dsn])`. Ressalvas B-3, B-4 e B-5 acima.

### 7. Sistema de arquivos e execução — **SÓLIDA no que entrou**

`spawn` só aparece em `runTool`/`runBoundedPgDump`, com `command` e `args` constantes do módulo e nada vindo de dado; o `pg_restore` lê por `/proc/self/fd/3` (descritor herdado) em vez de caminho. O que mudou no `runBoundedPgDump` foi trocar `stdio[2]` de `ignore` para `pipe` com teto de 2 KB — o acumulador não cresce sem limite (`slice(0, PG_DUMP_DIAGNOSTIC_LIMIT)` a cada chunk) e o filho continua recebendo `SIGKILL` no `catch`. O tratamento de symlink/`O_NOFOLLOW`/publicação atômica do backup de segurança **não foi tocado** neste candidato. Ressalvas B-6 (estático, pré-existente) e B-7 (recursos).

### 8. Supply chain — **SÓLIDA (provado)**

`git diff f1677b4..HEAD -- '*/package.json' 'package.json'` mostra **zero dependência externa nova**. O que entra é `plugins/action-approval/package.json` (só `workspace:*` internos + `zod 4.4.3`, a mesma versão já usada em todo o repositório) e `@dz23-studio/action-approval: workspace:*` em `plugins/staging`. Todo o barulho no `pnpm-lock.yaml` é normalização de identificador de peer (`(supports-color@9.4.0)` entrando na chave de `@babel/core`, `@modelcontextprotocol/sdk`, `express`, `express-rate-limit`): **nenhuma versão resolvida muda**, nenhum registry novo, nenhum pacote novo. Observação menor: `action-approval` declara `@dz23-studio/policy` como dependência mas o `src/` não o importa — dependência supérflua, sem risco.

---

## O que rodei

- `npx vitest run plugins/action-approval plugins/identity plugins/studio-web plugins/staging plugins/storage-postgres` com `DZ23_POSTGRES_TEST_DSN` e `DZ23_OPERATOR_STATE_DIR` reais → **42 arquivos, 399 testes, todos passando** (inclui os testes de Postgres real, que ficam de fora sem o DSN).
- Ataques próprios, escritos em `/tmp/auditB` (nunca no repositório), com config de vitest própria: `e2e.spec.ts` (IDOR ponta a ponta sobre servidor HTTP real + identidade real; vazamento de compactação; CSRF/Host/Origin/cabeçalho repetido), `approval.spec.ts` (confusão de escopo nos quatro eixos, rebaixamento T3→T2, replay/dupla reivindicação, expiração, corpo hostil, colisão de `approvalId`), `pgdump.spec.ts` (`pg_dump` real contra o PostgreSQL 16, leitura de `/proc/<pid>/cmdline`, senha errada, curinga de esquema, herança de `PGDATABASE`, IPv6), `ratelimit.spec.ts` (chave de limite por XFF). **9 + 5 + 1 asserções de ataque, todas com o resultado esperado.**
- Reproduções manuais com `psql` real para o comportamento de `PGHOST`.

## Condições para virar `GO` pleno

1. Ligar `action-approval` (B-1) ou parar de contar M90/M72 como entregues.
2. Corrigir a chave do limitador de taxa (B-2).
3. Recusar DSN sem `dbname` e desembrulhar host IPv6 (B-3, B-4) antes de qualquer restore destrutivo em produção.
