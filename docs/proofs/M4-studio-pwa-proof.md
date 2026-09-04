# M4 — Prova da interface do Studio como PWA

- Resultado: **PASS** (Chromium real no ambiente do Claude, 04/09/2026;
  números desta linha revistos na rodada de 04/09/2026 descrita na seção
  "Correções após o parecer NEEDS_FIX", que é a rodada realmente executada)
- `apps/studio-web` unitários na rodada original: 26/26 — política de cache (só casca, nunca `/api/`), worker (fonte sob vitest com `fetch`/`caches` simulados: install/activate, 503 `OFFLINE` sem rede, `AbortError` preservado, assets cache-first, casca network-first com fallback e com timeout de 4 s sobre servidor travado), notificações locais (mensagens do catálogo, estado desconhecido não notifica, só com permissão e aba oculta).
- Playwright `apps/studio-web` 6/6 em Chromium (mesmos 6 testes, reexecutados e ampliados na rodada nova): jornada original com axe intacta; manifesto instalável servido com três ícones PNG reais, `crossorigin="use-credentials"` e `Page.getAppManifest` sem erros; `/studio/sw.js` servido como `text/javascript`, IIFE sem `import`; service worker registrado e controlando a página; **com o servidor realmente fora do ar (proxy do teste fechado e sockets destruídos), a recarga mostra a casca e `/api/…` responde 503 `OFFLINE`**; o cache não contém nenhuma entrada `/api/`; faixa "Você está sem internet…" dirigida por `navigator.onLine`; `appinstalled` mostra a confirmação e volta a esconder a faixa; notificação local disparada pelo evento sintético com a aba oculta.
- Gates: `gate:i18n` PASS (catálogo PWA e manifesto varridos contra "pronto"), typecheck PASS, build reprodutível (versão do worker por digest do conteúdo).

Não executado ou pendente: instalação em aparelho físico (Android/iOS); Lighthouse (substituído pelas verificações acima); preview no celular (M1/HTTPS); **disparo real do evento de fim de criação e botão de permissão na interface** (integração em `App.tsx`, no handoff — até lá a notificação é `NOT_IMPLEMENTED` do lado da interface).

## Correção de honestidade (04/09/2026, após revisão do Codex)

O texto anterior da faixa dizia que, sem internet, "suas ações vão esperar a conexão voltar" —
**e não existe fila nem sincronização em segundo plano**. Era exatamente o tipo de promessa que
o projeto proíbe. O catálogo passou a dizer o que de fato acontece: a tela continua aberta para
ver o que já está nela, mas nada pode ser criado, salvo ou enviado até a conexão voltar; e uma
ação bloqueada avisa que o que foi digitado continua ali.

Além disso, o service worker passou a distinguir duas causas que antes eram a mesma frase:
`OFFLINE` (o aparelho está sem rede) e `SERVICE_UNREACHABLE` (há rede, mas o Studio não
respondeu — desligado ou reiniciando). O corpo do 503 carrega o código correspondente e a
interface tem uma frase para cada. Fila/`background sync` permanece `NOT_PRESENT`.

## Notificações: caminho do service worker e permissão por gesto (04/09/2026, mesma revisão)

O módulo mostrava a notificação com `new Notification(...)`. No Android/Chrome esse construtor
é **proibido** (`Illegal constructor`): quando existe service worker, só
`ServiceWorkerRegistration.showNotification()` funciona. Corrigido: o porto passa a usar a
registração assim que `navigator.serviceWorker.ready` resolve, o construtor fica de reserva para
navegadores de mesa sem worker, e a recusa dele é engolida — a notificação é cortesia e nunca
motivo para quebrar a tela. Teste novo simula o construtor proibido e verifica que a notificação
sai pela registração (26/26 unitários no `apps/studio-web`, contados na árvore desta entrega).

A permissão passou a ter um lugar só: o componente `NotificationOptIn`, que pede **a partir do
clique** (fora de um gesto do usuário o navegador recusa, e um pedido não solicitado é o caminho
mais rápido para um "bloqueado" permanente) e diz em palavras o que o navegador respondeu,
inclusive quando ficou bloqueado — o que só as configurações do próprio navegador desfazem.

**O estado da matriz continua `NOT_IMPLEMENTED`, de propósito:** a interface principal
(`App.tsx`, arquivo do Codex) ainda não aplicou `INTEGRACAO_App_tsx_M4_M5.patch`, e **nada disso
foi provado em aparelho físico**. Notificação em celular real não é algo que se declare pronto a
partir de um teste em Chromium de mesa.

### Achado meu, na própria correção

A prova em Chromium (`tests/pwa.spec.ts`) ainda afirmava o texto ANTIGO da faixa e o código
`OFFLINE` para o caso "servidor fora do ar com internet funcionando". Ou seja: a correção de
honestidade tinha sido feita no produto e não no teste que a vigia. Corrigido no mesmo dia — o
teste agora exige `SERVICE_UNREACHABLE` quando só o Studio caiu, `OFFLINE` quando o aparelho
está mesmo sem rede (`context.setOffline(true)`), e falha se a frase da faixa voltar a prometer
que as ações "vão esperar a conexão". Playwright 6/6 em Chromium real.


## Correções após o parecer NEEDS_FIX do Codex (04/09/2026)

Esta é a rodada cujos números valem. **Executado agora, nesta árvore
(`claude/fix-m4`, base `0db7258`), e não copiado de rodada anterior:**

- `cd apps/studio-web && npx vitest run` → **44/44 em 9 arquivos** naquela rodada
  (eram 26/26 em 6 arquivos). Nesta árvore, hoje, o mesmo comando dá **47/47 em 9
  arquivos**: três testes foram acrescentados a esses mesmos arquivos depois desta
  prova (medido em 04/09/2026). Os 18 novos cobrem: separação OFFLINE × SERVICE_UNREACHABLE em
  leitura e em mutação; frase de ação bloqueada sem promessa de fila; regra do
  `202`; deduplicação de aviso por `run_id` + estado; rejeição de
  `showNotification()` sem erro não tratado; e o `git apply --check` do patch.
- `DZ23_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test` → **6/6 em
  Chromium real**, incluindo as asserções novas: com o servidor fora do ar, um
  **POST** para `/api/…` também responde `503 SERVICE_UNREACHABLE`; com o
  aparelho realmente sem rede, o mesmo POST responde `503 OFFLINE`; e a mesma
  execução terminando três vezes gera **um** aviso, enquanto outra execução no
  mesmo estado gera o seu.
- `pnpm typecheck` → PASS. `pnpm gate:i18n` → `I18N_GATE=PASS locale=pt-BR
  keys=199 plugin_literals_grandfathered=19`.
- `git apply --check apps/studio-web/INTEGRACAO_App_tsx_M4_M5.patch` → saída
  vazia, código 0, contra a base `0db72580a8f6044aff7bb2ef345b67b135306d58`.

### O que foi corrigido

1. **A tela dizia "criando" antes de existir execução.** `App.tsx` marcava
   `GENERATING` antes do POST; sem internet, a interface afirmava criar um
   aplicativo que não existia. A regra passou a viver em
   `src/pwa/generation.ts`: só `202` com `run_id` vira `GENERATING`; qualquer
   outra resposta devolve o projeto a `PLAN_APPROVED` e diz por quê. A chamada
   entra por patch, porque `App.tsx` é de outro agente.
2. **O patch antigo só traduzia `{ offline: true }` e não aplicava mais.**
   Regerado (`apps/studio-web/INTEGRACAO_App_tsx_M4_M5.patch`, com explicação
   em português no `.md` ao lado): distingue as duas causas em GET e em POST,
   usa a frase de ação bloqueada nas mutações e não inventa fila nenhuma.
3. **Avisos repetidos.** O evento não levava `run_id` e nada era deduplicado:
   duas voltas do ciclo sobre a mesma execução terminada avisavam duas vezes.
   Agora o evento leva o `run_id` e cada par execução/estado avisa uma vez.
4. **`showNotification()` sem tratamento de rejeição.** A promessa podia virar
   um `unhandledrejection`. Passou a ser tratada, e a falha do aviso é
   silenciosa de propósito.
5. **Documentos desatualizados.** A ADR-030 descrevia o 503 com um código só e
   dizia que a tradução era item futuro; esta prova trazia números de outra
   rodada. Ambos foram reescritos para descrever o que o código faz hoje.

### Achado meu, que o parecer não apontou

- O `blockedAction` do catálogo existia desde a correção anterior e **nunca era
  usado**: sem `App.tsx` integrado, nenhuma mutação chegava a mostrá-lo. A
  frase estava escrita e morta. Agora ela é escolhida por
  `apiFailureMessage(..., 'mutation')`, e há teste que falha se a frase de
  leitura e a de mutação voltarem a ser a mesma.
- O `tag` da notificação era fixo (`dz23-generation`), então duas execuções
  diferentes se substituíam na bandeja do sistema. Passou a haver um `tag` por
  execução.
- A rota `/api/` no worker já respondia a POST, mas nenhuma prova em navegador
  exercitava um POST bloqueado. Agora exercita, nas duas causas.

### O que continua NÃO provado, de propósito

- **Notificação em aparelho físico: `NOT_EXECUTED`.** Nada aqui foi visto em um
  celular real; Chromium de mesa não prova telefone. O estado da matriz para
  esse item permanece `NOT_IMPLEMENTED`/`NOT_EXECUTED`.
- **Instalação em Android/iOS reais: `NOT_EXECUTED`.**
- **Ponta a ponta da tela com o patch aplicado: `NOT_EXECUTED`.** O `App.tsx`
  desta árvore é do Codex e não foi alterado; o patch foi provado por
  `git apply --check` e por testes de unidade dos módulos que ele chama, não
  por uma jornada com a tela já integrada. Isso só pode ser provado na árvore
  onde o patch for aplicado.
- **Fila / `background sync`: `NOT_PRESENT`**, e há teste que falha se o patch
  introduzir um esboço de fila.
