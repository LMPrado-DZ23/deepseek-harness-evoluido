# AUDITOR B — Segunda passada: verificação das correções

- Repositório: `/home/claude/integ`
- HEAD verificado: `3efa588c0d9942d61bdd387fd1437a89b5a5a979` (`manifesto, chave morta e a suposição escrita`)
- Base do relatório original: `98d2650`; correções em 15 commits (`git log --oneline 98d2650..HEAD`)
- Método: **ataque**, não leitura. Toda mutação deliberada foi feita com cópia de segurança e restauração em `trap ... EXIT`, e o `git status` foi conferido depois de cada uma.
- Docker real disponível (`docker info` → engine 29.4.3), portanto H-1 pôde ser falsificada de verdade.
- Nada foi enviado, publicado ou removido. `third_party/deepseek-harness` foi mutado UMA vez e restaurado: `git status --porcelain` dentro dele terminou com **0 linhas**.
- Estado do repositório ao final: limpo, salvo por `audit/verificacao/` — diretório não rastreado que **não é meu** (surgiu durante a sessão, contém `palpite.spec.ts`, `palpite.txt`, `vitest.config.ts` e um `node_modules`; provavelmente de outro auditor em paralelo). Não toquei nele.

## Placar

| Item | Veredito |
|---|---|
| H-1 prova de endurecimento lê o `src/` | **CORRIGIDO** |
| H-2 `gate:tracked-lib` | **CORRIGIDO** |
| M-1 detector de i18n | **PARCIAL** |
| M-2 `prove-builder-isolation` deriva do produto | **PARCIAL** |
| M-3 chave do limitador de taxa | **CORRIGIDO** |
| M-4 portões ausentes da CI | **CORRIGIDO** |
| M-5 licenças em modo release na CI | **PARCIAL** (deliberado e documentado) |
| M-6 CSRF rotacionável | **PARCIAL** |
| M-7 varredura de segredos | **CORRIGIDO** |
| M-8 `gate:team-role-tools` lê o Harness | **CORRIGIDO** |
| L-1 Host/Origin em `authenticatedMutation` | **PARCIAL** |
| L-4 ambiente do filho do backup | **CORRIGIDO** (com resíduo na API) |
| L-5 `.svg`/`.bundle` varridos | **CORRIGIDO** |

Regressões introduzidas pelas correções: **nenhuma** na suíte nem nos portões (2726 testes passaram, 172 arquivos; 15 portões verdes). Achados NOVOS: **3** (ver seção final), sendo um deles MEDIUM e nascido diretamente da correção de H-2.

---

## H-1 — CORRIGIDO

A prova agora importa `plugins/builder-supervisor/src/docker-adapter.ts` via `tsx` (`scripts/prove-container-hardening.mjs:47-48`), e o `package.json:45` passou a chamá-la com `tsx`.

Refiz **a mesma mutação** do relatório original, com Docker de verdade:

```
$ perl -0pi -e "s/NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: \['ALL'\]/NetworkMode: 'bridge', ReadonlyRootfs: false, Privileged: false, CapDrop: []/" plugins/builder-supervisor/src/docker-adapter.ts
$ pnpm -s prove:container-hardening
CONTAINER_HARDENING_SELF_TEST=PASS enfraquecimentos=4
CONTAINER_HARDENING=FAIL
- NetworkMode declarado bridge
- ReadonlyRootfs não foi aplicado
- CapDrop declarado null
- a rede não foi bloqueada: ALCANCAVEL
- o contêiner enxerga interfaces além do loopback: eth0, lo
PROOF_EXIT=1
--- RESTAURADO ---   (git status --porcelain: vazio)
```

Antes da mutação, a mesma prova saía `decision: GO`, `EXIT=0`. A sabotagem que antes passava agora reprova, e reprova pelo motivo certo, citando as três opções mutadas **e** o efeito observado no contêiner. Fonte declarada e fonte carregada são o mesmo arquivo. Fechado.

## H-2 — CORRIGIDO

```
$ pnpm -s gate:tracked-lib ; echo exit=$?
TRACKED_LIB_SELF_TEST=PASS negative_detected=1 manifesto=PASS
TRACKED_LIB=PASS files=179 findings=0
exit=0
$ git ls-files plugins/route-health/lib/ | head -3
plugins/route-health/lib/i18n.d.ts
plugins/route-health/lib/i18n.d.ts.map
plugins/route-health/lib/i18n.js
```

O `i18n.js` entrou no índice; o portão está verde onde estava vermelho.

E ele **detecta o caso real**, comprovado num repositório git descartável (fora do projeto), com um `lib/` versionado importando arquivo não versionado:

```
$ cd <tmp> && git init -q . && echo 'import { t } from "./i18n.js"' > plugins/foo/lib/index.js && git add -A
$ node /home/claude/integ/scripts/check-tracked-lib.mjs ; echo exit=$?
plugins/foo/lib/index.js importa './i18n.js', que não está versionado (plugins/foo/lib/i18n.js)
plugins/foo/package.json: sem exports["."]
TRACKED_LIB=FAIL files=1 findings=2
exit=1
```

Ganhou de brinde a conferência de manifesto (`exports["."]`), que também reprova. Fechado — mas ver **N-2** nos achados novos: a decisão de VERSIONAR o `lib/` abriu outro buraco.

## M-1 — PARCIAL

O detector melhorou de verdade: as quatro frases que eu tinha usado para contorná-lo agora são apanhadas.

```
DETECTA "Acesso negado: o token expirou. Entre novamente."
DETECTA "Chave invalida."
DETECTA "Erro interno inesperado no servidor."
DETECTA "Recurso indisponivel no momento"
```

Contornei de novo. Frases que uma pessoa leria e o detector não vê:

```
CEGO    "Acesso negado"
CEGO    "Falha grave no servidor"
CEGO    "Chave secreta ausente"
CEGO    "Erro interno"
CEGO    "Sem permissao"
CEGO    "Fila cheia"
CEGO    "Login expirou"
CEGO    "Time sem vaga"
```

Ataque de ponta a ponta, num `plugins/*/src` ESTRITO (`plugins/identity` tem `i18n/pt-BR.json`):

```
$ printf '\nexport const AUDIT_PROBE_B1 = "Acesso negado"\nexport const AUDIT_PROBE_B2 = "Falha grave no servidor"\nexport const AUDIT_PROBE_B3 = "Chave secreta ausente"\n' >> plugins/identity/src/http.ts
$ pnpm -s gate:i18n
I18N_GATE=PASS locale=pt-BR catalogs=25 keys=499 plugin_literals_grandfathered=1 ...
GATE_EXIT=0
--- RESTAURADO ---
```

**Onde ele continua cego, com precisão:**

1. **Palavra solta** — `if (!/\s/u.test(value)) return false` (`i18n-baseline-shared.mjs:53`). Qualquer literal de uma palavra só passa por construção, inclusive `"Recusado."`, `"Expirou."`, `"Indisponivel."`. A justificativa (nome de parâmetro, perfil comparado por valor) é boa; o efeito colateral é uma porta que nunca fecha.
2. **Sem terminação e sem palavra funcional** — o par substantivo+adjetivo/particípio curto é o ponto cego estrutural: `"Acesso negado"`, `"Fila cheia"`, `"Chave secreta ausente"`. `negado` não casa `\w{5,}ado` (`neg` tem 3), `cheia` e `ausente` não casam nada, e nenhuma delas está na lista de 90 palavras.
3. **Terminação exige ≥5 caracteres antes de `ado/ido/ada/ida`** — então toda a família curta escapa: `negado`, `pedido`, `criado`, `usado`, `salvo`.
4. **Ainda é lista fechada.** A correção trocou "lista de palavras" por "lista de palavras + lista de terminações". É o mesmo tipo de artefato, com raio maior. A recomendação do relatório original continua de pé: perguntar "isto é texto exibido?" (argumento de JSX, `message`, `reason`, `label`, retorno de função de erro) em vez de "isto é português?".
5. `gate:i18n` continua sendo o único portão substantivo sem `--self-test` (`package.json:63`), e o `scripts/i18n-detector.spec.mjs` não ganhou os contraexemplos acima.

Não é falha de segurança; é dívida de veracidade do portão — mede o que o detector enxerga, não o que existe.

## M-2 — PARCIAL

A derivação existe e é real: `scripts/prove-builder-isolation.mjs:31-32` importa `hardenedHost` do `src/` e `productFlags()` traduz o `HostConfig` para linha de comando. Nada de `securityArgs` redigitado.

Como o script morre antes de tudo por falta da imagem, verifiquei por leitura **e** extraindo `productFlags` do arquivo para executá-la isolada:

```
$ pnpm -s prove:builder-isolation
Error: ENOENT ... open '/home/claude/integ/runtime/builder-image-digest'
EXIT=1
```

```
$ node -e "<extrai productFlags do próprio script e chama com um host sabotado>"
host = { ..., Privileged: true, PublishAllPorts: true, PortBindings: {'80/tcp':[...]}, OomKillDisable: true, ... }
saída = ["--network","none","--read-only","--cap-drop","ALL","--security-opt","no-new-privileges",
         "--pids-limit","256","--memory","1","--cpus","1","--shm-size","268435456",
         "--ipc","private","--tmpfs","/tmp:rw,noexec"]
```

**Quatro campos do produto não são traduzidos e três deles são justamente os que a prova AFIRMA conferir:**

- `Privileged` — `productFlags` não emite `--privileged`. Se `hardenedHost` passar a devolver `Privileged: true`, o contêiner da prova sobe **não** privilegiado, e o teste `privilegedFalse: inspection.HostConfig.Privileged === false` (`:88`) passa. A prova ficaria verde afirmando que o construtor não é privilegiado enquanto o produto o pede privilegiado. É exatamente o erro que M-2 apontou, sobrevivendo num campo.
- `PublishAllPorts` e `PortBindings` — não traduzidos, e não conferidos por check nenhum. Um produto que publicasse portas não seria visto.
- `OomKillDisable` — não traduzido nem conferido (impacto baixo).

**Valores ainda redigitados na prova:**

- `Mounts` — `hardenedHost` recebe `mounts` e devolve `Mounts: mounts`; a prova chama com `[]` e escreve os próprios `--mount` (`:42-44`). Portanto `workspaceOnlyWritableMount`, `templateStoreReadOnly`, `noDockerSocketMount` e `noTrustStoreMount` provam as montagens **da prova**, não as que `containerBody` monta em `docker-adapter.ts:120,148,187-188`.
- `--user` e as três variáveis de ambiente (`:45-46`) são redigitadas. O desvio de `--user` está documentado e é legítimo (dono do bind); o do `Env` não é — `ephemeralHome` (`:96`) confere strings que a própria prova acabou de escrever.
- `NetworkDisabled: true`, que o produto põe no corpo do contêiner (`docker-adapter.ts:253`), não tem correspondente.

O que MELHOROU e é real: `NetworkMode`, `ReadonlyRootfs`, `CapDrop`, `SecurityOpt`, `PidsLimit`, `Memory`, `NanoCpus`, `ShmSize`, `IpcMode`, `Tmpfs` e `Ulimits` vêm do produto — uma mutação em qualquer um deles derruba a prova. Falta fechar `Privileged`, `PublishAllPorts`/`PortBindings` e as montagens.

Nota: `prove:builder-isolation` continua fora da CI (só `prove:container-hardening` entrou).

## M-3 — CORRIGIDO

`plugins/identity/src/rate-limit.ts:78-82` (`edgeForwardedAddress` → `hops.at(-1)`) e o Caddy substitui o cabeçalho nos três blocos do Studio (`deploy/caddy/DZ23.common.caddy:72,84,93`, `header_up X-Forwarded-For {remote_host}` — `set`, não append).

```
$ npx tsx <probe>
1.2.3.4, 203.0.113.7         -> hop= 203.0.113.7    key= 67cdcc3e953d22c5
9.9.9.9, 203.0.113.7         -> hop= 203.0.113.7    key= 67cdcc3e953d22c5
203.0.113.7                  -> hop= 203.0.113.7    key= 67cdcc3e953d22c5
a, b, c, 203.0.113.7         -> hop= 203.0.113.7    key= 67cdcc3e953d22c5
undefined                    -> hop= undefined      key= 900847d7ec672c61
```

Uma única chave para o mesmo cliente, seja qual for o prefixo forjado. Ataques que tentei e **não** funcionam:

- **Cabeçalho duplicado.** O Node junta ocorrências repetidas de `x-forwarded-for` numa string com vírgula, então o último hop continua sendo o da borda; e `singleHeader` (`http.ts:356-358`) devolve `undefined` para array de tamanho >1, o que cai no `socket.remoteAddress` — nunca em valor do cliente.
- **Apagar o cabeçalho.** `edgeForwardedAddress(undefined)` → `undefined` → `rateLimitKey` usa `request.socket.remoteAddress` (`rate-limit.ts:90-92`), que é o endereço da borda. Perde-se granularidade (todos num balde), não se ganha escolha de balde.
- **Rota fora dos blocos protegidos.** `@public_identity` cobre `/magic/*`, `/passkey/login/*` e `/logout`; `@studio_surface` cobre `/api/studio/*`. Todas as rotas da identidade caem em um dos dois, e os três `Caddyfile*` importam o mesmo `dz23_edge`.
- **Ordem.** `assertRequestTrust` (`http.ts:92`) roda ANTES do limitador (`:101-104`), então Host/Origin já filtraram.

**Resíduo (não é o achado, é o entorno):** o balde é consumido antes de `assertEdgeTrust`, que só é chamado no caminho do principal. Quem alcançar a porta da aplicação **diretamente** (sem passar pelo Caddy) ainda escolhe o balde e pode fixar a chave de uma vítima, mesmo sendo recusado depois pelo segredo de borda. A defesa que sobra aí é o `prove:loopback` — a aplicação só escuta em loopback. Registro como defesa em profundidade, não como achado aberto.

## M-4 — CORRIGIDO

`.github/workflows/verify.yml` ganhou `pnpm gate:team-role-tools` (:118), `pnpm gate:rls-coverage` (:119) — ambos dentro do passo "Static and policy gates", **bloqueantes** — e um passo próprio `Container hardening proof` (:199-205) rodando `pnpm prove:container-hardening`, também bloqueante. Os três comandos existem e rodam:

```
$ pnpm -s gate:team-role-tools
TEAM_ROLE_TOOLS_SELF_TEST=PASS checks=5
TEAM_ROLE_TOOLS=PASS papeis=8 roster=edit,read,read_image,write leitura=read,read_image extensoes_lidas=6/6
exit=0

$ pnpm -s gate:rls-coverage
RLS_COVERAGE=PASS migrados=1/26 pendentes=25
exit=0

$ pnpm -s prove:container-hardening
CONTAINER_HARDENING_SELF_TEST=PASS enfraquecimentos=4
{ "decision": "GO", ... }
EXIT=0
```

Entraram também `Studio web interface suite` e `Studio browser suite` (Playwright), que eu não tinha pedido e cobrem buracos reais. `prove:loopback` e os demais `prove:*` continuam fora — aceitável, já que o que respondia pelo confinamento entrou.

## M-5 — PARCIAL (deliberado e documentado)

O passo existe (`verify.yml:154-164`, `Release license blockers (C-05, informativo)`) e o comando reprova de verdade:

```
$ pnpm -s gate:licenses:release ; echo exit=$?
IMPEDE PUBLICAR: @anthropic-ai/claude-agent-sdk: Não é redistribuível. ...
IMPEDE PUBLICAR: @anthropic-ai/claude-agent-sdk-linux-x64: ...
RELEASE_LICENSES=FAIL pacotes=850 ... bloqueiam_publicacao=2 ... modo=release
exit=1
```

Mas o passo carrega `continue-on-error: true`. Ou seja: **o sinal saiu de dentro de um passo verde e virou um passo próprio, nomeado, vermelho na leitura — mas ainda não reprova o commit.** O comentário assume isso por escrito e atribui a decisão ao Prado (C-05): conviver com a restrição como instalação privada ou tirar o subagente do perfil. Isso resolve metade do que eu apontei (a invisibilidade) e deixa a outra metade em aberto por decisão de produto, não por descuido. Marco PARCIAL porque nenhuma barreira impede a publicação; a decisão apenas deixou de ser invisível. Falta o que sugeri no original: um passo de release obrigatório antes de qualquer publicação.

## M-6 — PARCIAL

Corrigido de fato: o token CSRF tem versão 2 com semente (`service.ts:49-53`) e `finishStepUp` gira a semente e o `csrf_hash` sem derrubar a sessão (`service.ts:665-673`). Existe teste (`plugins/identity/tests/service.spec.ts:615-644`) que exige `after !== before` e que a sessão continue a mesma.

**O ataque que ainda funciona:** `#issueSession` cria a sessão **sem semente** (`service.ts:717`, `derivedCsrfToken(tokenHash)` sem segundo argumento). Não é só "sessão antiga" — é **toda sessão nova**. Provei acrescentando um teste temporário ao spec da identidade (restaurado depois):

```
AssertionError: expected { Object (seed, estavel, ...) } to deeply equal ...
- Expected                          + Received
-   "seed": "SEMENTE-PRESENTE",     +   "seed": "AUSENTE",
-   "estavel": false,               +   "estavel": true,
-   "funcaoPuraDoTokenHash": false, +   "funcaoPuraDoTokenHash": true,
```

Leitura: uma sessão recém-emitida (a) nasce sem `csrf_seed`, (b) devolve sempre o mesmo `csrfTokenFor`, e (c) esse valor continua sendo exatamente `sha256('dz23-csrf-v1:' + token_hash)` — função pura e determinística do token de sessão, como antes.

Consequências:

1. **Sessão antiga sem semente continua funcionando** — sim, e isso é declarado como compatibilidade. O problema é que o caminho v1 não é legado: é o **padrão de nascimento**. Enquanto a pessoa não fizer uma elevação, o vazamento pontual do token CSRF continua valendo pelos 90 dias inteiros. Meia correção.
2. **A rotação invalida o valor anterior** — sim. `validateCsrfToken` (`service.ts:360-364`) compara com `session.csrf_hash`, que `finishStepUp` regrava. O valor antigo passa a ser recusado. Esta metade está fechada.
3. **Falta rotação em outro ponto de elevação?** Varri: `last_strong_auth_at` só é escrito em `finishStepUp` (`:671`) e zerado em `#issueSession` (`:732`). Não há outra elevação de privilégio no serviço — nem o login por passkey conta como confirmação forte. Então **não** falta rotação em outro ponto hoje; falta a rotação *periódica* e a semeadura no nascimento.
4. Também continua ausente a **reemissão do token de sessão** em elevação, que eu havia sugerido: `finishStepUp` troca o CSRF e mantém o token de sessão.

Correção que fecharia: semear em `#issueSession` (e então o ramo v1 vira de fato só compatibilidade) e regenerar a semente em `csrfTokenFor` a cada N minutos.

## M-7 — CORRIGIDO

Isenção nominal (`SECRET_ALLOWLIST`, 11 entradas com arquivo+regra+motivo, e o portão reprova isenção obsoleta: `isencoes=11 obsoletas=0`), `PLACEHOLDER` fechado num conjunto explícito, e `SKIPPED` sem `.svg`/`.bundle`.

Tentei esconder um segredo de verdade:

```
$ printf '\n// ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' >> plugins/identity/tests/rate-limit.spec.ts
$ pnpm -s gate:secrets
SECRET_SCAN_SELF_TEST=PASS checks=21
plugins/identity/tests/rate-limit.spec.ts:82 possível github-token
SECRET_SCAN=FAIL arquivos=1253 achados=1 isencoes=11 obsoletas=0
GATE_EXIT=1
--- RESTAURADO ---
```

Matriz do ataque (`secretFindings` direto):

```
REPROVA  segredo em teste             plugins/x/tests/a.spec.ts
REPROVA  segredo em .svg              apps/studio-web/public/logo.svg
REPROVA  segredo em .bundle           backups/repo.bundle
REPROVA  DSN senha MAIUSCULA          postgres://u:HUNTER2GATO@h/d     <- fechou
REPROVA  token slack                  xoxb-...
PASSA    DSN senha=secret / =teste                                     <- marcador declarado, aceitável
PASSA    segredo hex de 64 (DZ23_EDGE_SECRET)                          <- sem regra
PASSA    token em base64
PASSA    token concatenado ("ghp_" + "aaa...")
PULADO   .tar / .png
```

Os três declarados estão fechados. O que passa é a limitação inerente de varredura por padrão — não regressão, não promessa quebrada: o portão nunca afirmou pegar entropia genérica. Vale registrar que **o segredo da própria borda (`DZ23_EDGE_SECRET`, hex de 64) não tem regra**, e é o segredo mais consequente do produto.

## M-8 — CORRIGIDO

`scripts/check-team-role-tools.ts:37-44` guarda só o CAMINHO de cada extensão; `registeredTools()` lê os nomes de `defineTool({ name: '...' })` em arquivo que chama `tools.register(`. A saída passou a imprimir `extensoes_lidas=6/6`.

Registrei uma ferramenta de mentira dentro do Harness fixado, numa extensão que o preset monta:

```
$ cat >> third_party/deepseek-harness/packages/fs/tool-fs/src/edit.ts <<'EOF'
const auditFake = defineTool({ name: 'multi_edit', description: 'x' })
void auditFake
EOF
$ npx tsx scripts/check-team-role-tools.ts
TEAM_ROLE_TOOLS=FAIL
- COORDINATOR_ROSTER (edit,read,read_image,write) não bate com o preset (edit,multi_edit,read,read_image,write)
EXIT=1
--- RESTAURADO ---
third_party dirty=0
```

Acusa, e acusa **pelo nome da ferramenta nova**. Era exatamente o cenário `multi_edit` que eu descrevi. Upstream restaurado: `git status --porcelain` em `third_party/deepseek-harness` = 0 linhas.

Uma aspereza (ver **N-3**): pelo `pnpm gate:team-role-tools`, que roda com `--self-test`, a mesma mutação sai como `Error: self-test: o roster real já reprova` e uma pilha de exceção, sem nomear a ferramenta. Reprova — mas quem ler o log da CI não descobre o motivo sem rodar o comando sem `--self-test`.

## L-1 — PARCIAL

`authenticatedMutation` (`plugins/identity/src/http.ts:288-293`) passou a chamar `service.assertRequestTrust(host, origin, mutating)` antes de autenticar, e `mutating` é derivado do método. Isso alcança os 6 plugins que eu listei.

Ataquei os três vetores que você pediu:

```
$ npx tsx <probe de authenticatedMutation com Host/Origin do atacante>
sem setRequestTrust ->  Entre para continuar.      <- a checagem NÃO recusou; seguiu para authenticate
duble sem metodo    ->  TypeError: service.assertRequestTrust is not a function
com trust           ->  HOST-RECUSADO
```

1. **Serviço sem `setRequestTrust` chamado: falha ABERTA.** `service.ts:384-385` — `const trust = this.#requestTrust; if (trust === undefined) return`. Sem declaração de confiança, `assertRequestTrust` é um no-op silencioso e a proteção de L-1 desaparece por inteiro. `setRequestTrust` tem **um único** ponto de chamada em todo o repositório (`plugins/identity/src/index.ts:219`): qualquer montagem que construa o `StudioIdentityService` sem passar por esse caminho reverte a correção sem um sinal. E o getter `requestTrustConfigured` (`service.ts:375`), cujo comentário afirma "o portão confere que sim", **não é lido por portão, teste ou código nenhum** — ver **N-1**.
2. **Dublê sem o método:** `TypeError`, que nos handlers cai no ramo genérico e vira 500. Fecha, mas fecha por acidente e com o erro errado; um dublê de teste que omita o método quebra em vez de silenciar, o que é o comportamento desejável.
3. **Rota que não passe por `authenticatedMutation`:** varri `identity.authenticate(` fora da identidade — sobra **um** caso, `plugins/integration-hub/src/http.ts:263`, e ele está coberto pelo `assertRequestTrust(request, {...})` no topo do próprio handler (`:106`), com hosts/origens explícitos e sem depender do estado do serviço. Não sobrou rota autenticada descoberta.

Ou seja: o buraco declarado fechou; o que resta é o **fail-open na ausência de configuração**, que é a mesma classe de "proteção que parece existir" que originou `gate:team-role-tools`. Correção: `assertRequestTrust` lançar quando `#requestTrust` for `undefined`, ou um portão que use `requestTrustConfigured` de verdade.

## L-4 — CORRIGIDO (com resíduo na API)

`plugins/storage-postgres/src/index.ts:187-197`: o ambiente do filho é montado com `PATH`, `LANG`, `TMPDIR` e o DSN, cada um condicionado a existir. Nada de `...process.env`. A doutrina de `mcp-client/src/environment.ts` passou a valer aqui.

Resíduo: `plugins/storage-postgres/src/backup.ts:104` mantém `env: options.env ?? process.env`. O caminho do produto sempre passa `env`, mas `childProcessBackupRunner` é **exportado** (`index.ts:28`) e seu padrão continua sendo herdar o ambiente inteiro. Um chamador novo que esqueça `env` reabre o achado em silêncio. Tornar `env` obrigatório no tipo custa uma linha.

## L-5 — CORRIGIDO

`scripts/check-secrets.mjs:135` — `SKIPPED` agora é `png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|gz|tar|wasm|mp4`. `.svg` e `.bundle` saíram e são varridos (comprovado na matriz de M-7: ambos REPROVAM). `.gz` ficou, com justificativa escrita e correta (conteúdo comprimido não casa regra de texto).

---

## Regressões

Nenhuma. Conferido:

```
$ npx vitest run --maxWorkers=1
 Test Files  172 passed | 8 skipped (180)
      Tests  2726 passed | 65 skipped (2791)
```

E os 15 portões da CI, um a um, todos `exit=0`: `gate:i18n`, `gate:portability`, `gate:domain-scopes`, `gate:domain-routes`, `gate:assistant-tools`, `gate:team-role-tools`, `gate:rls-coverage`, `gate:tracked-lib`, `gate:image-lock`, `gate:requirements-ledger`, `gate:secrets`, `gate:no-caveman`, `gate:p37`, `gate:licenses`, `gate:upstream-pin`.

---

## Achados novos

### N-1 (LOW) — `requestTrustConfigured` é um acessor morto cujo comentário afirma um portão que não existe

- **Arquivo:linha:** `plugins/identity/src/service.ts:374-375`
- O comentário diz, literalmente, `/** Se a confiança de requisição foi declarada (o portão confere que sim). */`. Não há portão.

```
$ grep -rn "requestTrustConfigured" --exclude-dir=node_modules .
./plugins/identity/src/service.ts:375
./plugins/identity/lib/service.js:266
./plugins/identity/lib/service.d.ts:104
```

Três ocorrências: a definição no fonte e a mesma definição compilada. Zero leitores. É a categoria "a suposição escrita" que o próprio commit `3efa588` diz estar caçando, sobrevivendo dentro da correção de L-1. Ou o portão é escrito (e então o fail-open de L-1 fecha junto), ou a frase entre parênteses sai.

### N-2 (MEDIUM) — O `lib/` versionado é a única parte do repositório que nenhum passo confere contra o `src/`, e é o que o pacote publica

- **Arquivos:** `.github/workflows/verify.yml:222-223`; `plugins/*/package.json` (`"main": "./lib/index.js"`, `exports["."].default = "./lib/index.js"`, `"files": ["lib","i18n"]`)
- Nove plugins têm `lib/` versionado: `agents`, `assistant-bridge`, `hello`, `identity`, `policy`, `route-health`, `runtime-governor`, `storage-postgres`, `tenancy`. Toda a suíte importa `../src/*.ts`; nenhum teste toca o `lib/`. O último passo da CI, "Refuse unexpected build mutations", é `git diff --exit-code -- . ':(exclude)plugins/*/lib/**'` — exclui exatamente esse diretório.
- **Prova:** sabotei o artefato versionado da identidade removendo a validação de CSRF e nada acusou.

```
$ perl -0pi -e "s/validateCsrfToken\(session, headerToken\) \{/validateCsrfToken(session, headerToken) { return;/" plugins/identity/lib/service.js
$ pnpm -s gate:tracked-lib
TRACKED_LIB_SELF_TEST=PASS negative_detected=1 manifesto=PASS
TRACKED_LIB=PASS files=179 findings=0        exit=0
$ git diff --exit-code -- . ':(exclude)plugins/*/lib/**' ; echo exit=$?
exit=0                                        <- o passo da CI passa
$ git diff --stat
 plugins/identity/lib/service.js | 2 +-        <- a sabotagem está lá, e ninguém a vê
--- RESTAURADO ---
```

- **Impacto:** o `exports` resolve o CÓDIGO no `lib/` (`default: ./lib/index.js`), então é o `lib/` que EXECUTA. Na CI o `pnpm build` regenera o diretório, o que salva o job — mas o artefato commitado é o que viaja para quem clona sem construir e é o que `files: ["lib"]` empacota. Hoje está em dia (rodei `pnpm --filter @dz23-studio/identity build` e o `git status` ficou limpo), então isto é buraco latente, não deriva ativa.
- É a consequência direta da escolha feita em H-2: versionar o `lib/` em vez de tirá-lo do índice. Fechou o `ERR_MODULE_NOT_FOUND` e abriu um artefato sem dono.
- **Correção sugerida:** no passo final da CI, rodar `pnpm build` e depois `git diff --exit-code` SEM a exclusão para os nove plugins com `lib/` versionado — ou seja, exigir que o artefato commitado seja bit a bit o que o `src/` gera. Alternativamente, `git rm --cached` do `lib/` e ajustar `exports` para o fluxo de build, que era a outra saída já registrada em H-2.
- **Teste que provaria:** a sabotagem acima terminando com `exit != 0`.

### N-3 (LOW) — Duas asperezas de diagnóstico nas próprias correções

- **(a)** `pnpm gate:team-role-tools` roda com `--self-test`, e o self-test aborta em `scripts/check-team-role-tools.ts:206` com `Error: self-test: o roster real já reprova` **antes** de a verificação real imprimir o achado. Uma ferramenta nova no Harness reprova — correto — mas o log da CI mostra uma pilha de exceção em vez de `- COORDINATOR_ROSTER (...) não bate com o preset (..., multi_edit, ...)`. Quem for consertar precisa descobrir sozinho que tem de rodar sem `--self-test`. Sugestão: rodar a verificação real primeiro, ou nomear a divergência dentro da mensagem do self-test.
- **(b)** `scripts/prove-container-hardening.mjs:29` continua documentando `Uso: node scripts/prove-container-hardening.mjs [--self-test]`. Depois da correção de H-1 o arquivo importa TypeScript e essa linha não funciona mais:

```
$ node scripts/prove-container-hardening.mjs
  code: 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX'
EXIT=1
```

  O `package.json:45` está certo (`tsx`); só o cabeçalho ficou para trás. Uma linha.

---

## Veredito

As duas HIGH estão fechadas, e fechadas de verdade: refiz a mutação exata que produzia o verde artificial em H-1 e a prova reprovou contra o Docker real, nomeando as três opções sabotadas; H-2 está verde e o portão apanha o caso que ele existe para apanhar. M-3, M-4, M-7, M-8, L-4 e L-5 também resistiram ao ataque. Não há regressão: 2726 testes e 15 portões verdes.

O que ficou pela metade tem um padrão comum, e vale dizê-lo por extenso: **em quatro dos cinco PARCIAIS, o caminho novo foi construído ao lado do antigo e o antigo continua sendo o padrão.** M-6 semeia o CSRF na elevação mas nasce sem semente; L-1 confere Host e Origin mas não recusa quando ninguém declarou a confiança; L-4 monta o ambiente do filho no produto mas mantém `?? process.env` no padrão da API exportada; M-2 deriva onze campos do produto e deixa `Privileged` de fora. M-1 é de outra natureza — trocou uma lista fechada por uma lista fechada maior.

O achado novo que eu levaria para a reunião é **N-2**: a saída escolhida para H-2 tornou o `lib/` um artefato versionado, executável e publicado que nenhum teste importa e que o último passo da CI exclui por nome. Uma sabotagem que apaga a validação de CSRF do artefato passa por todos os portões. Recomendo fechá-lo antes de qualquer release — é barato (tirar a exclusão do `git diff` depois do build) e é a única coisa nesta lista que um atacante com acesso de escrita ao repositório poderia usar sem deixar rastro em portão nenhum.
