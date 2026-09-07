# ADR-030 — Interface do Studio como PWA (M4)

Status: aceita e implementada na etapa M4 (Claude), com saída segura integrada
na M80 (Codex). Numeração: a ADR-028 está reservada à M1 (preview) do Codex.

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

11. **Sem rede e sem a cópia salva, uma página em português.** Quando o
   navegador joga fora o Cache Storage (o que ele faz sozinho sob pressão de
   armazenamento, mantendo o worker registrado) e a rede cai, não há casca
   para servir. O worker respondia `new Response('', { status: 503 })` — sem
   corpo e sem tipo — e o Chrome transformava isso em
   `net::ERR_HTTP_RESPONSE_CODE_FAILURE`: a tela de erro do próprio navegador,
   em inglês, sem `document.body`. Era pior do que não ter service worker
   nenhum, porque sem ele a pessoa teria visto a página "sem internet" do
   navegador no idioma dela. Agora o worker devolve uma página HTML mínima em
   pt-BR (`offlineShellHtml()` em `policy.ts`, texto de
   `src/i18n/pwa.pt-BR.json`, `content-type: text/html; charset=utf-8`) que
   diz que o aparelho está sem internet, que a cópia do Studio não está mais
   aqui, e o que fazer. O texto entra no `sw.js` porque o Vite embute o JSON
   na build do worker — nada é importado em tempo de execução (o `sw.js`
   continua sem `import`, e isso é testado).
12. **Uma casca vinda do cache diz que é uma cópia salva.** O servidor manda
   `cache-control: no-store` em toda resposta de `/studio/` e responde `401`
   quando a sessão acabou; o worker ignorava as duas coisas. Sessão encerrada
   + aparelho offline devolvia a interface autenticada inteira, e a única
   coisa dita à pessoa era "você está sem internet" — quando a verdade era
   "sua sessão terminou". Não é vazamento do cache (nenhum dado de projeto é
   cacheado e `/api/` nunca é cacheado). O cliente usa somente duas chaves
   próprias fora do Cache Storage: o CSRF da sessão em `sessionStorage` e a
   seleção da sessão do Assistente em `localStorage`; não usa `indexedDB`. Era
   um estado que ninguém conseguia entender, e num aparelho compartilhado a
   próxima pessoa vê o Studio "aberto". Agora: (a) o worker marca a origem da
   casca **por navegação**, em `/studio/__shell-source?client=<id da página>`
   dentro do próprio Cache Storage — uma página não lê os cabeçalhos da própria
   navegação, então ela pergunta ao worker que a controla (`dz23:shell-source?`)
   e recebe a resposta sobre a navegação que criou **aquela** página; a resposta
   também acrescenta `x-dz23-shell-source: cache` para quem inspeciona;
   (b) `registerStudioPwa()` faz essa pergunta e mostra o aviso
   `.pwa-cached-shell` com o texto `offline.cachedShell`, separado da faixa de
   offline porque as duas coisas são diferentes e podem ser verdade ao mesmo
   tempo — uma página sem controlador (recarga que passa por cima do worker) não
   tem a quem perguntar e não afirma nada; (c) um `401` **numa navegação** de
   `/studio/` apaga todo cache `dz23-studio-shell-*`, que é o fim de sessão que
   existe hoje neste produto; (d) `forgetSavedShell()`
   é o gancho para um botão de sair — a página avisa o worker
   (`dz23:shell-logout`), ele apaga os caches e confirma; sem worker, a própria
   página apaga. A M80 ligou esse gancho ao botão **Sair**: o cliente faz um
   `POST /api/studio/identity/logout` autenticado e protegido por CSRF; o
   servidor revoga exatamente a sessão corrente e só então responde
   `signed_out: true`. Somente após essa prova o cliente apaga os caches e as
   duas chaves DZ23 e segue para o caminho fixo `/login`. Falha do servidor
   preserva a tela e o estado local e mostra erro, sem fingir que a saída
   ocorreu. Falha de limpeza do navegador depois da revogação é melhor esforço
   e não restaura autoridade no servidor.

13. **A marca era global; agora é de cada tela, e o `401` só conta quando é
   uma tela.** Duas suspeitas da auditoria, as duas verificadas no navegador:
   (i) `__shell-source` era **um slot só** para um fato que é de cada
   navegação, gravado por último-escreve-vence. Reproduzido em Chromium com
   `Network.setBypassServiceWorker` (o Shift+Reload): visita offline deixa o
   slot em `cache`, a internet volta, a pessoa recarrega passando por cima do
   worker — a navegação não passa pelo `fetch`, nada corrige o slot, e quem
   tinha sessão viva (o `/api/` respondendo 200 na mesma tela) lia "Mostrando a
   tela salva neste aparelho; entre de novo quando a internet voltar". Com duas
   abas o mesmo defeito acontece ao contrário. Fechado como descrito em (a) e
   (b); a prova em navegador está em `tests/pwa.spec.ts` e a das duas abas em
   `src/pwa/sw.spec.ts`. (ii) `decide()` classifica **qualquer** GET sem
   extensão sob `/studio/` como `shell-html`, então um `401` de qualquer um
   desses caminhos apagava a casca inteira. Hoje tudo sob `/studio/` é a mesma
   interface, então ninguém foi prejudicado — mas "ainda não existe caminho
   diferente" não é guarda. O gatilho passou a ser o que o estado significa:
   uma **tela** foi recusada (`request.mode === 'navigate'`). Um pedido que a
   própria página faz sendo recusado não é a sessão acabando e não esvazia o
   aparelho; a recusa de uma navegação continua esvaziando, e há teste para as
   duas metades.

14. **Uma saída confirmada alcança todas as abas, mas uma prévia não decide o
    que preservar.** A M82 coloca um boundary acima da escolha de tela em
    `main.tsx`; Início, Hub e Assistente recebem o mesmo sinal versionado e sem
    dados por `BroadcastChannel`, com evento de `localStorage` como fallback.
    A aba receptora nunca repete o POST: consulta a sessão duas vezes e limpa
    somente depois de duas respostas não autenticadas. Para não apagar um
    login novo concluído enquanto a resposta antiga estava em voo, magic e
    passkey devolvem um nonce aleatório não autoritativo que a página de login
    grava em `localStorage` na origem do Studio. Cookies não são usados nessa
    decisão: uma prévia em `p-*.dz23.localhost` pode criar um cookie para o
    domínio pai, mas não pode escrever no armazenamento da origem
    `studio.dz23.localhost`. O teste adversarial rotaciona esse cookie durante
    a consulta final e exige limpeza e `/login`; outro teste conclui um login
    legítimo no mesmo instante e exige preservação da nova sessão. Sinais
    duplicados são deduplicados, callbacks concorrentes são agrupados e todos
    os listeners são removidos no unmount.

## Limites verdadeiros

Sem push, sem sincronização em segundo plano, sem cache de dados: **não há
fila**. Uma ação bloqueada é dita como bloqueada — o que a pessoa digitou
continua na tela e ela pode tentar de novo —, nunca como algo que será enviado
sozinho quando a conexão voltar. Instalação
em Android/Chrome real e em iOS (`apple-touch-icon` presente; Safari não emite
`beforeinstallprompt`) não foram executadas em aparelho físico:
`NOT_EXECUTED`. O preview no celular depende da M1 (HTTPS em domínio real) e
segue `NOT_EXECUTED` com o texto do próprio cartão de preview.

A M80 foi provada por testes unitários e build em clone WSL2/ext4. A M81
acrescentou a jornada completa em Chromium: sucesso revoga antes de limpar,
falha preserva tela/estado e o modo pessoal não mostra uma ação impossível. A
rota exata de logout agora atravessa o Caddy sem `forward_auth`, mas conserva no
handler o segredo de borda, Host, Origin e CSRF da sessão ativa; cookie ausente
ou já revogado pode ser apagado idempotentemente. Uma prévia continua sob o
ticket/TTL próprio, mas a autorização revalida a sessão de origem a cada pedido
e o teste prova a recusa imediatamente após revogação. Caddy/Docker real nesta
etapa e aparelho físico continuam `NOT_EXECUTED`. Evidência em
`docs/proofs/M80-secure-signout.md` e
`docs/proofs/M81-secure-signout-browser-e2e.md`. A M82 acrescentou a
sincronização entre telas e abas, a proteção da corrida de novo login e a
prova de que cookie plantado pela prévia não controla a limpeza. Evidência em
`docs/proofs/M82-cross-tab-secure-signout.md`.

## O que continua em aberto

**`skipWaiting()` + `clients.claim()` com o `activate` apagando o cache
anterior.** Uma versão nova ativa embaixo de uma aba já aberta e remove do
cache os assets que aquela aba ainda poderia pedir. Isso **não pode falhar
hoje**: a interface é construída como **um único pedaço**, sem `import()`
dinâmico, então uma aba em execução já carregou tudo o que vai precisar. O dia
em que o bundle for dividido — uma rota preguiçosa, qualquer `import()` — isso
deixa de ser verdade e vira defeito real. Não foi "consertado": inventar agora
o rastreio de clientes por versão seria acrescentar um mecanismo que nenhum
teste consegue fazer falhar. Em vez disso ficou uma **guarda que cai no dia
exato em que a condição chegar**: o teste "a casca continua sendo um unico
pedaco" (`apps/studio-web/tests/pwa.spec.ts`) lê `dist/assets` depois da build
e exige um único `.js` sem `import(` — a mensagem de falha diz o que fazer
então (manter o cache da versão anterior até o último cliente dela sair, ou
parar de reivindicar clientes). Estado: `NOT_PRESENT` (a condição que tornaria
o defeito alcançável não existe nesta build).
