# Integração M4/M5 em `App.tsx` — o que este patch muda e por quê

O arquivo `apps/studio-web/src/App.tsx` é de outro agente (Codex). Por isso a
integração das etapas M4 (PWA, offline, notificações locais) e M5 (Hub de
integrações) chega como **patch**, não como edição.

- Patch: `apps/studio-web/INTEGRACAO_App_tsx_M4_M5.patch`
- Base contra a qual foi gerado: commit `0db72580a8f6044aff7bb2ef345b67b135306d58`
  (ponta da branch `claude/fix-m4` neste worktree). A base integrada real
  (`a1a4ec6`) **não existe neste clone**; ver "Sobre a base", no fim.
- Conferência: `git apply --check apps/studio-web/INTEGRACAO_App_tsx_M4_M5.patch`
  (executada a cada rodada de testes por `src/pwa/integrationPatch.spec.ts`).

O patch toca **um único arquivo**, `App.tsx`. Toda a lógica mora em módulos da
M4 (`apps/studio-web/src/pwa/`), com teste de unidade próprio; no `App.tsx`
ficam só as chamadas. Isso é proposital: o que o Codex precisa revisar são
poucas linhas, e o comportamento pode ser provado sem montar a tela.

## 1. "Sem internet" e "o Studio não respondeu" deixam de ser a mesma frase

Antes, uma chamada que falhava virava, na tela, o texto cru do erro — e a única
tradução existente olhava para `{ offline: true }`. Duas coisas muito
diferentes ficavam iguais:

- **OFFLINE** — o aparelho está sem rede. O pedido não saiu da máquina.
- **SERVICE_UNREACHABLE** — o aparelho tem rede e o Studio é que não respondeu
  (desligado, reiniciando). Se o pedido chegou ou não, ninguém sabe.

Quem separa as duas é o service worker (`src/pwa/policy.ts`), que responde
`503` com um código no corpo. O patch passa esse código pela função
`apiFailureMessage` / `apiFailureText` (`src/pwa/apiFailure.ts`), que devolve a
frase do catálogo `src/i18n/pwa.pt-BR.json`. Vale para **leitura (GET)** e para
**ação (POST)**:

| Causa | Leitura (GET) | Ação (POST/mutação) |
| --- | --- | --- |
| OFFLINE | `offline.banner` | `offline.blockedAction` |
| SERVICE_UNREACHABLE | `offline.serviceUnreachable` | `offline.serviceUnreachable` |
| Qualquer outro erro | a frase que o próprio servidor mandou | idem |

`offline.blockedAction` é a **ação bloqueada**: diz que a ação precisa de
conexão, que o que a pessoa digitou continua na tela e que ela pode tentar de
novo. **Não** diz que a ação foi guardada, enfileirada ou que será enviada
sozinha depois — não existe fila nem `background sync`, e prometer isso seria
mentira. Há teste que falha se qualquer uma dessas frases voltar a prometer
fila, e teste que falha se o patch introduzir `localStorage`, `setInterval` ou
qualquer outro esboço de fila.

## 2. O projeto só diz que está criando depois do 202

Este era o problema mais grave. O fluxo antigo era:

```
setProjectState('GENERATING')      // a tela já diz "criando…"
await api(POST /generate)          // e só então tenta enviar
```

Sem internet, ou com o Studio fora do ar, a tela afirmava que estava criando um
aplicativo **quando não havia execução nenhuma em lugar nenhum**.

O patch inverte a ordem e usa `startGeneration` (`src/pwa/generation.ts`):

```
const started = await startGeneration(...)      // faz o POST e lê o STATUS
if (started.runId === null) {                   // não foi aceito
  setProjectState(GENERATION_REJECTED_STATE)    // volta a PLAN_APPROVED
  setError(started.message)                     // e diz por quê
  return
}
setProjectState('GENERATING')                   // só aqui, e só aqui
```

A regra é literal: **só `202` com um `run_id` significa que a execução existe.**
Qualquer outra coisa — 200, 409, 503, erro de rede, ou até um 202 sem `run_id`
para acompanhar — devolve o projeto, de forma determinística, ao estado em que
ele estava: `PLAN_APPROVED`. `startGeneration` nunca lança exceção; todo caminho
devolve um estado que a interface pode mostrar com verdade.

O POST precisou sair de `api.ts` (também arquivo do Codex) porque `api.ts`
devolve só o corpo já convertido, e a regra acima depende do **código de
status**. `postGeneration` faz esse único pedido, com o mesmo cabeçalho CSRF e
o mesmo prefixo `/api/studio/apps`. É uma duplicação pequena e consciente: se
um dia `api.ts` expuser o status, `postGeneration` pode ser apagado.

## 3. O aviso de fim de criação passa a levar o `run_id`

`pollProject` agora dispara `dispatchGenerationFinished(window, { state, runId })`.
Antes o evento levava só o estado, e a interface pesquisa o servidor em ciclo:
duas voltas caindo na mesma execução já terminada geravam **duas notificações
iguais** no aparelho da pessoa. Com o `run_id` no evento, o módulo de
notificações reconhece a repetição e avisa uma vez por execução e estado — e
avisa de novo, corretamente, quando é **outra** execução no mesmo estado.

## 4. Botão de permissão e link do Hub

- `<NotificationOptIn />` entra na barra superior. É o único lugar que pede
  permissão de notificação, e pede **de dentro do clique** da pessoa — fora de
  um gesto o navegador recusa, e um pedido não solicitado é o caminho mais
  rápido para um "bloqueado" permanente.
- Um link para `/studio/hub` (M5) entra na navegação lateral, com o rótulo
  `hub.navLabel` do catálogo.

## O que este patch NÃO faz

- Não cria fila, não repete pedido sozinho, não guarda ação para depois.
- Não promete instalação nem notificação em aparelho físico: isso continua
  `NOT_EXECUTED`, porque ninguém provou em celular real.
- Não muda `api.ts` nem nenhum outro arquivo de outro agente.

## Sobre a base

Este worktree **não contém** a base integrada `a1a4ec6`; o patch anterior foi
gerado contra ela e por isso deixou de aplicar aqui. O patch atual foi gerado
contra `0db72580a8f6044aff7bb2ef345b67b135306d58`, a ponta de `claude/fix-m4`
neste worktree, e essa base está escrita no cabeçalho do próprio arquivo `.patch`.
Se, na árvore integrada, o `App.tsx` tiver divergido, o patch precisa ser
regerado lá — o teste `integrationPatch.spec.ts` acusa isso na hora, com a
mensagem do próprio `git apply`.
