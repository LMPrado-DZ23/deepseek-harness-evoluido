# Fatia — OS-104: o teste de cookie passava aqui e reprovava lá, e o navegador era outro

## 1. A causa, medida

A CI do `cec83ca` corrigiu as duas causas da OS-103 — o job "Windows release
contracts" passou (`✓ ... in 47s`) e o job "Linux clean clone" deixou de morrer
no build aos 4 min e passou a rodar 12m18s. **Com isso apareceu uma terceira
falha, que as duas primeiras mascaravam**, na etapa "Studio browser suite":

```
1) [mesa] › tests/journey.spec.ts:16:1 › o login HTTP local grava sessão host-only…
   Expected substring: "__Host-dz23_studio_session=session-token"
   Received string:    "dz23_studio_session=session-token"
```

O teste passava aqui. Em vez de supor, **instalei o navegador que a CI instala**
e medi os dois, no mesmo servidor e no mesmo endereço
`studio.dz23.localhost:4179` sem TLS:

| Chromium | `Secure` sobre http | prefixo `__Host-` sobre http |
| --- | --- | --- |
| 133.0.6943.16 (build 1155 — **a que a CI instala**) | aceita | **RECUSA** |
| 141.0.7390.37 (build 1194 — a que a máquina local forçava) | aceita | aceita |

A sonda usa um cookie próprio (`__Host-sonda`), sem relação com a sessão, e
repete a medida em `localhost` e `127.0.0.1`: o resultado é o mesmo nos três
endereços. **A diferença não é o `*.localhost` ser contexto seguro** — isso
vale nas duas versões. A diferença é o PREFIXO.

## 2. O que estava errado, e não era só o teste

### 2.1 O comentário afirmava uma verdade de versão como se fosse do navegador

`plugins/identity/src/http.ts` dizia, em texto:

> "Ali ele aceita `Secure` sobre http, e aceita o prefixo `__Host-`. Foi medido
> num Chromium de verdade…"

Foi medido — **num Chromium só**. É a armadilha que este repositório já
registrou: um comentário que explica uma razão que o código não tem impede o
próximo leitor de procurar. Corrigido, com a tabela acima no lugar da
afirmação.

### 2.2 A consequência de produto — `IB-11`, MEDIUM, ABERTO

Onde o navegador recusa o prefixo, **o nome forte não é defesa nenhuma**. Sobra
`shadowCookieDeletions`, que a própria `cookies.ts` diz não ser a defesa porque
não alcança `Path=/api`. Ou seja: em Chromium 133, o aplicativo GERADO rodando
na prévia irmã volta a poder trancar a dona do Studio para fora plantando
`dz23_studio_session=…; Domain=dz23.localhost; Path=/api`.

Não é roubo de conta — o servidor continua recusando a ambiguidade. É a TRANCA.
A correção real é topológica (prévia fora do domínio irmão, ADR-012) e não cabe
nesta fatia; está registrada como `IB-11`.

### 2.3 O teste afirmava o que não podia afirmar sozinho

Ele exigia o `__Host-` no cabeçalho enviado — uma garantia do NAVEGADOR — como
se fosse do servidor. Reescrito em três partes:

1. **O que o servidor emite**, conferido sem navegador no meio, por chamada
   direta: os dois `Set-Cookie` têm de estar lá, o forte com `Secure` e
   `Path=/`. Determinístico, não depende de versão de nada.
2. **A capacidade do navegador, MEDIDA** por uma sonda com cookie próprio.
3. **A asserção que corresponde à medida**: onde o prefixo é aceito, ele TEM de
   chegar; onde é recusado, ele NÃO pode chegar — e o nome simples é conferido
   nos dois casos, porque ninguém pode ficar de fora por causa do nome que o
   navegador recusou.

Isto **não enfraquece** o teste: o antigo cobria um ramo e falhava no outro por
motivo ambiental; o novo cobre os dois e reprova a sabotagem nas duas versões.

## 3. A assimetria que escondeu tudo isso — fechada

A CI roda `pnpm exec playwright install chromium`, que instala a compilação
fixada pelo `@playwright/test` desta árvore (1155). A máquina local forçava
`DZ23_CHROMIUM_PATH=…/chromium-1194/…`, mais nova e mais permissiva.

`playwright.config.ts` passou a ler `playwright-core/browsers.json` e **recusa**
um `DZ23_CHROMIUM_PATH` cuja compilação não seja a fixada, a menos que se
declare `DZ23_CHROMIUM_OUTRA_COMPILACAO=sim` — que é como esta medição foi
feita. Forçar outro navegador continua possível; fazer isso em silêncio, não.

É a mesma classe do `gate:declared-imports` da OS-103: **portão que roda só na
máquina permissiva não é portão.**

## 4. Falsificação

| sabotagem | resultado |
| --- | --- |
| remover a emissão do `__Host-` em `serializeSessionCookies` | **PEGA** no Chromium 133 **e** no 141 (o teste antigo só pegava no 141) |
| `DZ23_CHROMIUM_PATH` apontando para o 1194 sem declarar | **PEGA** — a configuração recusa com o número da compilação fixada |

## 5. Provas

| prova | ambiente | resultado |
| --- | --- | --- |
| 26 portões | container local | `GATES_FAIL=0` |
| `check-constitution.mjs --verdicts` | container local | PASS, 42 vereditos |
| suíte da raiz | container local | 3812 passaram / 68 pulados |
| suíte `studio-web` | container local | 609 passaram |
| e2e, quatro viewports | **Chromium 133.0.6943.16 — o da CI** | 120 passaram / 3 pulados |
| suíte PostgreSQL 16 | `postgresql://…@127.0.0.1:5432/dz23_test` | 65 passaram, `POSTGRES_GATE=PASS` |

**Limitação declarada:** tudo acima é resultado LOCAL. A CI verde só existe
depois do push, e a execução correspondente a este commit ainda não foi
conferida. A prova de runtime Cordis continua `BLOCKED_BY_EXTERNAL_DEPENDENCY`
(não há Docker neste container) e o provedor real continua `EB-04`.
