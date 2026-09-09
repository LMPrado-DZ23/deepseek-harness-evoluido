# AUDITOR B — Segurança / DevSecOps

- Repositório: `/home/claude/integ`
- HEAD auditado: `98d265090a6f6a433c87dd9ed4d1928a21c6bab0` (`i18n: fecha a evasão por acento e limpa o typecheck`, 2026-09-09)
- Modo: leitura + execução não destrutiva. Toda mutação deliberada foi restaurada e conferida com `git diff --stat` vazio ao final de cada experimento.
- Nada foi enviado, publicado, removido ou alterado em `third_party/deepseek-harness`.

## Sumário por severidade

| Severidade | Quantidade |
|---|---|
| CRITICAL | 0 (**nenhum achado desta severidade** — ver "O que resistiu") |
| HIGH | 2 |
| MEDIUM | 8 |
| LOW | 5 |
| IMPROVEMENT | 2 |
| FALSE_POSITIVE | 2 |

---

## HIGH

### H-1 — A prova de endurecimento do contêiner aprova código que NÃO é o do produto (verde artificial demonstrado)

- **Arquivo:linha:** `scripts/prove-container-hardening.mjs:38` (`await import(... 'plugins/builder-supervisor/lib/docker-adapter.js')`) e `scripts/prove-container-hardening.mjs:181` (`source: 'plugins/builder-supervisor/src/docker-adapter.ts hardenedHost()'`)
- **Causa:** a prova importa o ARTEFATO COMPILADO (`lib/`) e imprime no relatório que a fonte é `src/docker-adapter.ts`. Não há verificação de que `lib/` corresponda a `src/`. Pior: `plugins/*/lib/` está em `.gitignore` (`.gitignore:14`), portanto o artefato provado é local, não versionado e não reprodutível — a frescura dele não é responsabilidade de ninguém.
- **Evidência (comando e saída reais):**

```
$ sed -i "s/return { NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: \['ALL'\]/return { NetworkMode: 'bridge', ReadonlyRootfs: false, Privileged: false, CapDrop: []/" plugins/builder-supervisor/src/docker-adapter.ts
$ node scripts/prove-container-hardening.mjs
...
    "network": "BLOCKED",
    "interfaces": "lo",
    "dockerSocket": "ABSENT",
    "noNewPrivs": 1,
    "capEff": 0
  },
  "note": "imagem base local de proposito: o que esta sob prova e o CONFINAMENTO, nao o conteudo da imagem"
}
PROOF_EXIT=0
```

  Ou seja: com a função do produto reescrita para `NetworkMode: 'bridge'`, `ReadonlyRootfs: false` e `CapDrop: []`, a prova imprimiu `decision: GO` e saiu 0, atribuindo o resultado a `src/docker-adapter.ts`. (Arquivo restaurado logo em seguida; `git diff --stat` vazio.)
- **Impacto:** a peça de evidência que o produto apresenta como "o endurecimento REALMENTE aplicado" pode ficar verde sobre um `lib/` velho enquanto o código que sobe o contêiner do construtor já não tem rede desligada, raiz somente-leitura nem `CapDrop: ALL`. Um construtor com rede é exfiltração do código do cliente; sem `CapDrop` e sem `ReadonlyRootfs` é escrita na imagem e escalada dentro do contêiner. Agrava: **nenhum `prove:*` roda na CI** (`.github/workflows/verify.yml` não tem uma única linha `pnpm prove:`), então esse verde é sempre local.
- **Reprodução:** o bloco acima. Restaure com `cp` do backup em `finally`.
- **Correção sugerida:** (a) importar de `src` via `tsx`/`--experimental-strip-types`, como fazem `check-team-role-tools.ts` e `check-assistant-tool-catalog.ts` (que importam `../plugins/**/src/*.ts`); ou (b) rodar `pnpm --filter @dz23-studio/builder-supervisor build` dentro da própria prova e recusar se o `lib/` estiver mais velho que o `src/` (comparar `mtime` e/ou hash); e (c) trocar a linha `source:` para dizer honestamente qual arquivo foi carregado.
- **Teste que provaria a correção:** um teste que copia o repositório para um diretório temporário, muta `hardenedHost` em `src/`, roda a prova e exige `exit != 0` com achado citando `NetworkMode`.

### H-2 — `gate:tracked-lib` está VERMELHO em HEAD: artefato versionado importa arquivo que o repositório não tem

- **Arquivo:linha:** `plugins/route-health/lib/index.js:4` e `plugins/route-health/lib/service.js` (versionados) importam `'./i18n.js'`, que não está em `git ls-files`.
- **Evidência:**

```
$ pnpm -s gate:tracked-lib ; echo exit=$?
TRACKED_LIB_SELF_TEST=PASS negative_detected=1
plugins/route-health/lib/index.js importa './i18n.js', que não está versionado (plugins/route-health/lib/i18n.js)
plugins/route-health/lib/service.js importa './i18n.js', que não está versionado (plugins/route-health/lib/i18n.js)
TRACKED_LIB=FAIL files=170 findings=2
exit=1

$ git ls-files plugins/route-health/lib/
plugins/route-health/lib/index.d.ts
plugins/route-health/lib/index.d.ts.map
plugins/route-health/lib/index.js
plugins/route-health/lib/model.d.ts
plugins/route-health/lib/model.d.ts.map
plugins/route-health/lib/model.js
plugins/route-health/lib/service.d.ts
plugins/route-health/lib/service.d.ts.map
plugins/route-health/lib/service.js
        (nenhum i18n.js)

$ git show :plugins/route-health/lib/index.js | head -5
import { authenticatedMutation } from '@dz23-studio/identity';
import { studioRouteHealthDomainSpec, } from './model.js';
import { StudioRouteHealthService } from './service.js';
import { t } from './i18n.js';
export * from './model.js';

$ git log --oneline -1 -- plugins/route-health/src/i18n.ts
98d2650 i18n: fecha a evasão por acento e limpa o typecheck
```

- **Causa:** o último commit criou `plugins/route-health/src/i18n.ts` e regravou o `lib/` versionado, mas `plugins/*/lib/` está no `.gitignore`, então o novo `lib/i18n.js` não entrou. `package.json` do plugin aponta `"main": "./lib/index.js"`.
- **Impacto:** a CI (`verify.yml` linha 116 executa `pnpm gate:tracked-lib`) reprova em HEAD. E o cenário que o portão nomeia acontece de verdade: um clone limpo que consuma `@dz23-studio/route-health` pelo `main` quebra com `ERR_MODULE_NOT_FOUND`. É exatamente a regressão de empacotamento que o portão foi escrito para impedir, entrando pelo commit que fechou outra.
- **Reprodução:** os três comandos acima, sem alterar nada.
- **Correção sugerida:** `git rm --cached -r plugins/route-health/lib` (o `.gitignore` já diz que esse diretório é build), ajustando `package.json`/`exports` para o fluxo de build; ou, se o `lib/` versionado precisa ficar, `git add -f plugins/route-health/lib/i18n.js` e adicionar um passo de "rebuild + `git diff --exit-code`" para o diretório.
- **Teste que provaria:** o próprio `gate:tracked-lib` saindo 0; mais um teste de "clone limpo" que instala e faz `import('@dz23-studio/route-health')`.

---

## MEDIUM

### M-1 — O detector de i18n continua contornável escrevendo sem acento (mesma classe do achado que 98d2650 diz ter fechado)

- **Arquivo:linha:** `scripts/i18n-baseline-shared.mjs:31-40` (`strongWords`, `weakWords`, `portugueseText`).
- **Causa:** a detecção passou de "só acento" para "acento OU uma palavra forte OU duas palavras fracas distintas". Continua sendo uma lista fechada de palavras; frase da pessoa que não use nenhuma delas passa.
- **Evidência:**

```
$ node -e "import('./scripts/i18n-baseline-shared.mjs').then(m=>{...})"
false  "Acesso negado: o token expirou. Entre novamente."
true   "Falha ao salvar o projeto."
false  "Chave invalida."
false  "Erro interno inesperado no servidor."
true   "Projeto criado com sucesso."
true   "Limite de uso atingido; tente mais tarde."
```

  E com mutação real no produto (arquivo restaurado depois; `git diff --stat` vazio):

```
$ printf '\nexport const AUDIT_PROBE_B = "Acesso negado: o token expirou. Entre novamente."\n' >> plugins/route-health/src/service.ts
$ node scripts/check-i18n.mjs
I18N_GATE=PASS locale=pt-BR catalogs=18 keys=441 plugin_literals_grandfathered=1 generated_source_literals=1 baseline=file
EXIT=0
```

- **Impacto:** o número que o portão imprime (`plugin_literals_grandfathered=1`) continua medindo o que o detector enxerga, não o que existe. Não é falha de segurança direta; é falha de VERACIDADE de portão, e é a categoria que o próprio repositório já classificou como a mais cara.
- **Correção sugerida:** parar de perguntar "é português?" e passar a perguntar "isto é texto de pessoa?": reprovar todo literal exibido (argumento de JSX, valor de `message`/`reason`/`label`, retorno de função de erro) que não venha de `t(...)`, com isenção nominal por arquivo. Alternativamente, cruzar com um dicionário pt-BR real em vez de 90 palavras.
- **Teste que provaria:** acrescentar ao `scripts/i18n-detector.spec.mjs` os quatro contraexemplos acima com `toBe(true)`. Hoje o spec só cobre as 5 frases do incidente original (`scripts/i18n-detector.spec.mjs:18-29`).
- **Nota adicional:** `gate:i18n` é o único portão substantivo sem `--self-test` (ver `package.json:63` contra as linhas 61-77).

### M-2 — `prove-builder-isolation.mjs` prova a CÓPIA das opções, não o produto

- **Arquivo:linha:** `scripts/prove-builder-isolation.mjs:23-34` (`const securityArgs = [...]` redigitado à mão).
- **Causa:** a prova monta o contêiner com uma lista de flags escrita no próprio script, sem importar nada de `plugins/builder-supervisor`. Se o produto parar de mandar `--network none`, esta prova continua verde.
- **Impacto:** evidência que parece cobrir o isolamento do construtor e não cobre o produto. É a mesma classe que o cabeçalho de `prove-container-hardening.mjs:16-22` critica explicitamente ("redigitar provaria a cópia, não o que o produto manda") — e a única prova que importa o produto é justamente a que importa o `lib/` (H-1). Somadas, H-1 + M-2 significam que **nenhuma prova executável vincula o confinamento real do construtor ao `src/` do produto**.
- **Reprodução:** leitura direta; não executei (exige `runtime/builder-image-digest` e a imagem construída — `NÃO COMPROVADO` empiricamente por falta da imagem).
- **Correção sugerida:** derivar `securityArgs` de `hardenedHost()` importado de `src`, como o `commandFlags()` de `prove-container-hardening.mjs` já faz.
- **Teste que provaria:** mutar `hardenedHost` em `src` e exigir que ambas as provas reprovem.

### M-3 — A chave do limitador de taxa da identidade é escolhida pelo cliente

- **Arquivo:linha:** `plugins/identity/src/http.ts:110-112` (`singleHeader(request.headers['x-forwarded-for'])?.split(',')[0]?.trim()`) e `plugins/identity/src/rate-limit.ts:63-73`.
- **Causa:** quando `edgeRequired === true`, o balde de rate limit é derivado do PRIMEIRO elemento de `X-Forwarded-For`. `reverse_proxy` do Caddy ACRESCENTA o IP real ao XFF que o cliente mandou, então o primeiro elemento é o valor do atacante.
- **Evidência (camada de aplicação, comprovada):**

```
$ npx tsx /tmp/rlprobe.mjs
1.2.3.4, 203.0.113.7       -> b83ccd60bdbaf31e
9.9.9.9, 203.0.113.7       -> bc255382ef5920a4
203.0.113.7                -> 67cdcc3e953d22c5
```

  Três chaves distintas para o mesmo cliente, escolhidas pelo cabeçalho.
- **NÃO COMPROVADO:** não subi o Caddy para confirmar o append (faltou ambiente de rede/edge). A afirmação sobre o comportamento do Caddy vem da leitura de `deploy/caddy/DZ23.common.caddy:65-83`, onde os blocos do Studio **não** removem `X-Forwarded-For` (a remoção existe só no bloco de prévia, linha 104).
- **Impacto:** os baldes `magic-start` (5/15min), `magic-verify` (10/min), `passkey` (20/min) e `global` (300/min) da aplicação viram inertes contra um atacante que rotacione o XFF. Mitigação real que salva a nota: o Caddy tem seus próprios `rate_limit` com `key {remote_host}` (`DZ23.common.caddy:13-46`), que não é falsificável. Portanto o risco material é a perda da defesa em profundidade e a inutilidade do limitador quando a borda for reconfigurada.
- **Correção sugerida:** usar o ÚLTIMO hop do XFF (ou `X-Real-IP` posto pela borda), ou um cabeçalho próprio assinado pela borda como já se faz com `X-DZ23-Edge`; e/ou o Caddy fazer `header_up X-Forwarded-For {remote_host}` (substituir, não acrescentar) nos blocos do Studio.
- **Teste que provaria:** teste de `rateLimitKey` exigindo a MESMA chave para `'1.2.3.4, 203.0.113.7'` e `'9.9.9.9, 203.0.113.7'`.

### M-4 — Portões e provas que existem e a CI não executa

- **Arquivo:linha:** `.github/workflows/verify.yml:106-144` contra `package.json:21-77`.
- **Evidência:** `grep -n "prove:" .github/workflows/verify.yml` → nenhuma linha. Ausentes da CI: `gate:rls-coverage`, `gate:team-role-tools`, `gate:upstream-pin` (a etapa da CI chama `node scripts/check-upstream-pin.mjs --self-test`, que roda a verificação real logo depois — este está coberto), e **todos** os `prove:*`.
- **Impacto:** `gate:rls-coverage` é o piso que impede o isolamento por linha de ENCOLHER (1/26 hoje) e ninguém o executa por commit; `gate:team-role-tools` é o portão nascido do achado `deny: ['network']` e também não roda. Um portão que ninguém executa não impede a regressão que ele foi escrito para impedir — o próprio comentário em `verify.yml:113-115` diz isso sobre outro portão.
- **Correção sugerida:** acrescentar `pnpm gate:rls-coverage` e `pnpm gate:team-role-tools` à etapa "Static and policy gates"; criar um job com Docker para `prove:container-hardening --self-test` e `prove:loopback`.

### M-5 — O portão de licenças reprova só num modo que a CI não usa

- **Arquivo:linha:** `package.json:76-77`; `.github/workflows/verify.yml:138`.
- **Evidência:**

```
$ pnpm -s gate:licenses ; echo exit=$?
aviso, impedirá publicar: @anthropic-ai/claude-agent-sdk: Não é redistribuível...
RELEASE_LICENSES=PASS pacotes=850 ... bloqueiam_publicacao=2 ... modo=repositorio
exit=0

$ pnpm -s gate:licenses:release ; echo exit=$?
IMPEDE PUBLICAR: @anthropic-ai/claude-agent-sdk: ...
RELEASE_LICENSES=FAIL pacotes=850 ... bloqueiam_publicacao=2 ... modo=release
exit=1
```

- **Impacto:** dois pacotes não redistribuíveis entram no artefato e o único sinal na CI é uma linha de log dentro de um passo verde. `gate:licenses:release` não é chamado em lugar nenhum de `verify.yml`.
- **Correção sugerida:** rodar `gate:licenses:release` no job (ou em um job de release obrigatório antes de qualquer publicação) e falhar. Se a decisão é conviver com a restrição, registrar isso como bloqueio explícito de publicação num passo próprio, não como aviso dentro de um passo que passa.

### M-6 — O token CSRF é uma função determinística e imutável do token de sessão

- **Arquivo:linha:** `plugins/identity/src/service.ts:42` (`derivedCsrfToken(tokenHash) = sha256('dz23-csrf-v1:' + tokenHash)`), usado em `#issueSession` (`service.ts:659`) e `csrfTokenFor` (`service.ts:343-352`).
- **Causa:** o token CSRF nunca é rotacionado; `GET /csrf` sempre devolve o mesmo valor para a mesma sessão. `serializeSessionCookies` (`http.ts:66-75`) inclusive EXPIRA o cookie CSRF (`Max-Age=0`) e o double-submit foi abandonado — a defesa é `x-dz23-csrf` + `Origin`.
- **Impacto:** um vazamento pontual do token CSRF (log de proxy, extensão, captura de tela, XSS efêmero) vale pelo resto da vida da sessão (até 90 dias absolutos). Também não há rotação de token de sessão em step-up: `finishStepUp` (`service.ts:600+`) marca `last_strong_auth_at` sem reemitir a sessão.
- **Correção sugerida:** derivar o CSRF de um segredo por sessão rotacionável (campo `csrf_seed` regenerado em `csrfTokenFor` a cada N minutos e em todo step-up), e reemitir o token de sessão em elevação de privilégio.
- **Teste que provaria:** teste exigindo que dois `csrfTokenFor` separados por um step-up devolvam valores diferentes e que o anterior passe a ser recusado.

### M-7 — A varredura de segredos isenta, por padrão, todo arquivo de teste

- **Arquivo:linha:** `scripts/check-secrets.mjs:57-58` (`FIXTURE_PATH`) e `scripts/check-secrets.mjs:44` (`PLACEHOLDER`).
- **Causa:** `FIXTURE_PATH` isenta qualquer caminho sob `tests/`, `test/`, `fixtures/` e qualquer `*.spec.*`/`*.test.*`. O próprio self-test confirma: `['fixture de teste é isenta', secretFindings('plugins/x/tests/a.spec.ts', 'ghp_'+'a'.repeat(36)).length === 0]`.
- **Impacto:** um segredo REAL colado num teste (o lugar mais comum onde isso acontece) sai no repositório e no histórico sem um único sinal — que é exatamente o cenário que o portão declara existir para impedir. Secundariamente, `PLACEHOLDER` aceita qualquer senha inteiramente em maiúsculas (`^[A-Z][A-Z0-9_]{2,}$`), então `postgres://u:HUNTER2GATO@h/d` passa.
- **Evidência:** leitura do código + o próprio caso 11 do self-test (`SECRET_SCAN_SELF_TEST=PASS checks=19`).
- **Correção sugerida:** trocar a isenção larga por isenção NOMINAL (lista `path`+`rule` com motivo, como já existe em `SECRET_ALLOWLIST`), e restringir `PLACEHOLDER` a um conjunto fechado de marcadores.
- **Teste que provaria:** caso de self-test exigindo que `plugins/x/tests/a.spec.ts` com `ghp_...` REPROVE, salvo isenção nominal.

### M-8 — `gate:team-role-tools`: a tabela que traduz extensão→ferramenta é ela mesma um palpite, e a checagem de rede é vacuosa

- **Arquivo:linha:** `scripts/check-team-role-tools.ts:31-38` (`TOOLS_BY_EXTENSION`) e `:104-107` (checagem de rede).
- **Causa:** o portão nasceu do achado "não adivinhe o nome da ferramenta", mas mapeia `tool-fs → read,read_image,write,edit` etc. por uma tabela escrita à mão, não derivada do Harness fixado. Se `@deepseek-ai/dsh-tool-fs` registrar uma ferramenta a mais (ex.: `multi_edit`), o portão não a vê e um papel de leitura pode passar a enxergá-la sem que nada reprove. Além disso, o roster REAL do preset é só `read,read_image,write,edit` (saída: `roster=edit,read,read_image,write`), então o teste "papel enxerga rede sem poder" é trivialmente verdadeiro contra o roster real — só o self-test com roster injetado o exercita.
- **Evidência:**

```
$ pnpm -s gate:team-role-tools
TEAM_ROLE_TOOLS_SELF_TEST=PASS checks=5
TEAM_ROLE_TOOLS=PASS papeis=8 roster=edit,read,read_image,write leitura=read,read_image
$ cat dsh-home/.agent-presets/dz23-coordinator-in-process/agent.cordis.yml   # monta só persona + tool-fs
```

- **Impacto:** MEDIUM e não maior porque a política é lista de PERMISSÃO (`roles.ts:109-126`): ferramenta nova não nomeada já está negada. O risco é o portão AFIRMAR uma cobertura que ele não tem.
- **Correção sugerida:** derivar `TOOLS_BY_EXTENSION` do Harness fixado (varrer `third_party/deepseek-harness/packages/extensions/*/src` por `ctx.tools.register('<nome>'`) e reprovar quando a tabela divergir.

---

## LOW

- **L-1 — `authenticatedMutation` não confere Host nem Origin.** `plugins/identity/src/http.ts:287-295`. É o ponto de entrada de autenticação de 6 plugins (`tenancy`, `prompt-to-app`, `studio-web`, `route-health`, `stuck-runs`, `team-panel`) e valida só `x-dz23-csrf`. A proteção contra CSRF cross-site sobrevive porque um cabeçalho customizado exige preflight CORS e não há cabeçalhos CORS na resposta — mas a checagem de origem que `assertRequestTrust` faz para a identidade não vale para essas rotas. Sugestão: chamar `assertRequestTrust` dentro de `authenticatedMutation`.
- **L-2 — Contratos de rota da identidade são declarativos.** `plugins/identity/src/http.ts:34-53` declara `access: 'authorized', permission: 'identity.self'`, mas `createIdentityHttpHandler` nunca chama `roleAllows`. Hoje é inofensivo (todo papel tem `identity.self`, `plugins/policy/src/rbac.ts:24-36`), mas o dia em que uma rota da identidade exigir outra permissão, a declaração continuará sendo só um comentário tipado.
- **L-3 — `as never` esconde renomeação de campo do Harness.** `plugins/agents/src/index.ts:170`: `{ toolFilter: { ...inProcess.toolFilter } as never }`. Confirmei que `toolFilter?: ToolRestriction` com `{ allow?: readonly string[] }` existe no pin (`third_party/deepseek-harness/packages/core/tools/src/index.ts:681`), então HOJE está certo. O cast é a alavanca que faria a mesma proteção voltar a ser inerte em silêncio se o upstream renomear o campo.
- **L-4 — Filho de backup herda o `process.env` inteiro.** `plugins/storage-postgres/src/index.ts:187` (`env: { ...process.env, [BACKUP_DSN_ENV]: resolved.value }`), em contradição com a doutrina do próprio produto em `plugins/mcp-client/src/environment.ts:6-9` ("herdar o ambiente do Studio é como um segredo vaza"). O processo é nosso e o DSN é sanitizado do stderr (`backup.ts:117`), por isso LOW.
- **L-5 — `check-secrets` pula `.svg`, `.bundle`, `.gz`.** `scripts/check-secrets.mjs:70`. `.svg` é texto e cabe segredo; `.bundle` do git é o formato que a casa usa para backups de repositório.

---

## IMPROVEMENT

- **I-1 — Restrição de ferramenta não alcança registro por escopo.** `third_party/.../core/tools/src/index.ts:677-679` documenta: "Restrictions intersect and **do not affect scoped registrations**". `roleToolRestriction` é uma lista de permissão sobre ferramentas GLOBAIS. Não encontrei registro por escopo no Studio, então isto é uma suposição não escrita, não um buraco. Vale documentar em `plugins/agent-team/src/roles.ts` e cobrir com um teste.
- **I-2 — `prove-container-hardening` não tem caso negativo para `/tmp` executável.** Declarado e justificado no próprio arquivo (`:160-167`): o Docker aplica `noexec` sozinho. É honesto; fica registrado que a propriedade é garantida pelo runtime e não pelo produto.

---

## FALSE_POSITIVE

- **FP-1 — `deny: ['network']` ainda aparece no repositório.** `plugins/agents/tests/service.spec.ts:400`. É fixture de teste da camada genérica de `toolFilter`, não o caminho do produto. O produto usa `roleToolRestriction` (lista de permissão) em `plugins/agent-team/src/service.ts:261` e `plugins/assistant-bridge/src/service.ts:189,403`. Verificado, sem achado.
- **FP-2 — "1 de 26 domínios com RLS" não é achado meu.** `RLS_COVERAGE=PASS migrados=1/26 pendentes=25`. É um buraco real de isolamento (25 domínios isolados por código do produto, não pelo banco), mas está MEDIDO, CLASSIFICADO por motivo e travado por um piso que só pode subir (`scripts/check-rls-coverage.ts:46-52`). Registro como estado declarado, não como descoberta — a descoberta é que esse portão não roda na CI (M-4).

---

## O que resistiu (mutação deliberada, tudo restaurado)

Cada linha abaixo foi mutada no `src`, a suíte relevante rodou, o arquivo foi restaurado e `git diff --stat` ficou vazio.

| Mutação | Arquivo | Resultado |
|---|---|---|
| Checagem de `Origin` removida | `identity/src/http.ts:373` | **5 testes falharam** de 210 |
| `validateCsrfToken` sempre aceita | `identity/src/service.ts:337` | 1 falhou de 210 |
| Sessão revogada aceita | `identity/src/service.ts:695` | 3 falharam de 67 |
| Contador do autenticador (clone de passkey) ignorado | `identity/src/service.ts:771` | 1 falhou de 67 |
| `roleAllows` sempre `true` | `policy/src/rbac.ts:40` | 17 falharam de 871 |
| Modo pessoal ignora `bindHost` (valeria em `0.0.0.0`) | `identity/src/service.ts:167` | 1 falhou de 184 |
| `#sameScope` cross-tenant sempre `true` | `prompt-to-app/src/service.ts:376` | 4 falharam de 412 |
| `hardenedHost` com `NetworkMode: 'bridge'` | `builder-supervisor/src/docker-adapter.ts:263` | 1 teste unitário falhou — mas **a prova de contêiner passou** (H-1) |

Outras verificações que passaram no escrutínio: canonicalização e verificação Ed25519 do manifesto do hub (`manifest.ts:168-208`) verifica sobre os bytes CRUS, com esquema `.strict()` e `Object.hasOwn` contra poluição de protótipo; `mcp-client` monta o ambiente do filho do zero e exige caminho absoluto sem shell (`environment.ts`, `transport.ts:141-143`, `model.ts:37`); `prove-loopback-binding` recusa `0.0.0.0` no runtime real e comprova o soquete; `check-assistant-tool-catalog` faz três mutações negativas próprias e é fail-closed quando o YAML não casa; `check-domain-routes` reprova "zero arquivos" e "zero domínios" em vez de aprovar por vacuidade; a política de ferramentas é fail-closed em regra ausente, inválida ou sem permissão declarada (`policy/src/index.ts:315-355`).

---

## Veredito

O núcleo de autenticação, autorização e isolamento entre inquilinos é sólido e resiste a mutação deliberada — sete de oito sabotagens no `src` foram apanhadas por testes. **O problema está na camada de evidência, não no produto.** Dois achados HIGH: a prova de endurecimento do contêiner aprova um artefato compilado enquanto declara auditar a fonte (comprovado: `decision: GO` com a rede do construtor reescrita para `bridge`), e o portão de artefato versionado está VERMELHO em HEAD por causa do último commit. Somados a M-2 e M-4, o resultado é que hoje **nenhuma evidência executada por commit liga o confinamento real do construtor ao código do produto**. Recomendo não publicar release enquanto H-1 e H-2 não estiverem fechados, e tratar M-1 como dívida de veracidade de portão, não como pendência de tradução.
