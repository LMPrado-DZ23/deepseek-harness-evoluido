# ADR-030 — Interface do Studio como PWA (M4)

Status: aceita e implementada na etapa M4 (Claude). Numeração: a ADR-028 está
reservada à M1 (preview) do Codex.

## Decisões

1. **Casca offline, dados nunca.** O service worker (`apps/studio-web/src/pwa/sw.ts`,
   construído à parte como IIFE em `/studio/sw.js`, URL estável, sem
   `import`) guarda em cache só a casca da interface: `/studio/`,
   `manifest.json`, ícones, marca e os assets com hash. A casca é
   *network-first* com 4 s de tolerância a servidor travado e fallback do
   cache. Tudo sob `/api/` é rede-somente, **em qualquer método** (GET e
   mutações): sem resposta, o worker devolve `503` com uma de duas causas —
   `{"error":"OFFLINE","offline":true}` quando o aparelho está sem rede e
   `{"error":"SERVICE_UNREACHABLE","offline":false,"serviceUnreachable":true}`
   quando há rede e o Studio é que não respondeu. A faixa "Você está sem
   internet…" é dirigida pelos eventos `online`/`offline` do navegador, não
   pelo 503. Nenhum dado de projeto entra no cache — política em `policy.ts`,
   testada em unidade, no worker (fonte) e em Chromium real com a rede
   realmente derrubada por um proxy controlado pelo teste.
2. **Instalável, sem loja e sem push.** `manifest.json` com `scope`/`start_url`
   em `/studio/`, `display: standalone`, ícones 192/512 e *maskable* gerados do
   logotipo oficial (`scripts/build-pwa-icons.mjs`, saídas versionadas). O
   botão "Instalar" aparece só quando o navegador oferece `beforeinstallprompt`.
   Não há push nem servidor de notificações: as notificações são **locais**,
   disparadas pela própria aba quando a criação termina e a aba está em
   segundo plano, com permissão pedida por gesto da pessoa.
3. **Integração mínima e desacoplada.** A interface avisa o fim de uma criação
   com um evento DOM `dz23:generation-finished` (`detail.state` e
   `detail.runId`); o módulo PWA escuta o evento. `main.tsx` chama
   `registerStudioPwa()`; `App.tsx` não é tocado nesta etapa (o Codex está
   editando esse arquivo na M1) — as chamadas entram pelo patch
   `apps/studio-web/INTEGRACAO_App_tsx_M4_M5.patch`, explicado em português no
   `.md` ao lado. O patch mexe em um arquivo só; a lógica mora em módulos
   `src/pwa/` com teste próprio, e `src/pwa/integrationPatch.spec.ts` roda
   `git apply --check` a cada suíte, de modo que um patch que deixou de
   aplicar falha como qualquer outro teste.
4. **Textos em catálogo próprio.** `src/i18n/pwa.pt-BR.json`, para não
   colidir com o catálogo que a M1 edita; o gate de i18n varre esse catálogo
   e o `manifest.json` contra alegações de prontidão, e continua estrito
   sobre `apps/studio-web/src`. Os catálogos podem ser fundidos depois.
5. **Versão determinística do worker.** `sw-version.ts` deriva a versão do
   `package.json` e de um digest de `index.html`, `src/` e `public/`: o mesmo
   commit gera o mesmo `sw.js` (build reprodutível) e qualquer mudança real
   invalida o cache antigo no `activate`.
6. **Chromium reutilizável nas provas.** `DZ23_CHROMIUM_PATH` em
   `playwright.config.ts` aponta um Chromium já instalado (WSL sem download,
   ambiente do Claude) — nenhuma prova baixa navegador.
7. **Sem Lighthouse.** Em vez de adicionar a ferramenta (peso e inventário),
   a prova Playwright verifica os critérios de instalabilidade que ela mede:
   manifesto válido servido, ícones reais, `theme-color`, service worker
   ativo controlando a página, casca carregada sem rede. Auditoria de
   acessibilidade continua pelo axe na jornada.
8. **Uma notificação por execução e estado.** O aviso é identificado por
   `run_id` + estado final. A interface pesquisa o servidor em ciclo, e duas
   voltas sobre a mesma execução já terminada geravam dois avisos idênticos no
   aparelho da pessoa; agora a repetição é reconhecida e ignorada, enquanto
   **outra** execução no mesmo estado continua avisando. O evento sem `run_id`
   ainda avisa (uma vez por estado), para não silenciar quem dispara o evento
   fora do patch. O conjunto de chaves é limitado, para não crescer em uma
   sessão longa.
9. **A promessa de `showNotification()` é sempre tratada.** Uma permissão
   revogada no meio da sessão, um worker que sumiu ou um payload recusado
   fazem `registration.showNotification()` rejeitar. Sem tratamento isso
   aparecia como `unhandledrejection` em uma página que está inteira. A
   notificação é cortesia: sua falha é silenciosa de propósito, e a interface
   continua sendo a fonte da verdade.
10. **O estado `GENERATING` só depois do `202`.** A regra é do produto, não da
   tela: só uma resposta `202` com `run_id` significa que existe execução. O
   fluxo antigo marcava `GENERATING` **antes** do POST, de modo que, sem
   internet, a tela afirmava estar criando um aplicativo que não existia em
   lugar nenhum. A decisão vive em `src/pwa/generation.ts` (`startGeneration`),
   fora do `App.tsx`, para poder ser provada sem montar a tela; qualquer outra
   resposta devolve o projeto a `PLAN_APPROVED` de forma determinística e diz
   por quê. O POST precisou sair de `api.ts` porque `api.ts` devolve só o
   corpo, e a regra depende do código de status.

## Limites verdadeiros

A casca em cache é servida a quem abrir o navegador sem rede mesmo depois
de a sessão expirar ou ser revogada: é só a interface estática (sem dado de
projeto, `/api/` nunca cacheado, respostas 401 nunca cacheadas), mas o
"recusa a interface sem sessão" do `plugins/studio-web` só vale com rede.
Sem push, sem sincronização em segundo plano, sem cache de dados: **não há
fila**. Uma ação bloqueada é dita como bloqueada — o que a pessoa digitou
continua na tela e ela pode tentar de novo —, nunca como algo que será enviado
sozinho quando a conexão voltar. Instalação
em Android/Chrome real e em iOS (`apple-touch-icon` presente; Safari não emite
`beforeinstallprompt`) não foram executadas em aparelho físico:
`NOT_EXECUTED`. O preview no celular depende da M1 (HTTPS em domínio real) e
segue `NOT_EXECUTED` com o texto do próprio cartão de preview.
