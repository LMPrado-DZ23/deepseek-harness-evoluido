# M4 — Prova da interface do Studio como PWA

- Resultado: **PASS** (Chromium real no ambiente do Claude, 04/09/2026)
- `apps/studio-web` unitários: 13/13 — política de cache (só casca, nunca `/api/`), worker (fonte sob vitest com `fetch`/`caches` simulados: install/activate, 503 `OFFLINE` sem rede, `AbortError` preservado, assets cache-first, casca network-first com fallback e com timeout de 4 s sobre servidor travado), notificações locais (mensagens do catálogo, estado desconhecido não notifica, só com permissão e aba oculta).
- Playwright `apps/studio-web` 6/6 em Chromium: jornada original com axe intacta; manifesto instalável servido com três ícones PNG reais, `crossorigin="use-credentials"` e `Page.getAppManifest` sem erros; `/studio/sw.js` servido como `text/javascript`, IIFE sem `import`; service worker registrado e controlando a página; **com o servidor realmente fora do ar (proxy do teste fechado e sockets destruídos), a recarga mostra a casca e `/api/…` responde 503 `OFFLINE`**; o cache não contém nenhuma entrada `/api/`; faixa "Você está sem internet…" dirigida por `navigator.onLine`; `appinstalled` mostra a confirmação e volta a esconder a faixa; notificação local disparada pelo evento sintético com a aba oculta.
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
sai pela registração (25/25 unitários no `apps/studio-web`).

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
