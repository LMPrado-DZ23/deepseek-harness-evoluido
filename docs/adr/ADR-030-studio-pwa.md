# ADR-030 — Interface do Studio como PWA (M4)

Status: aceita e implementada na etapa M4 (Claude). Numeração: a ADR-028 está
reservada à M1 (preview) do Codex.

## Decisões

1. **Casca offline, dados nunca.** O service worker (`apps/studio-web/src/pwa/sw.ts`,
   publicado em `/studio/sw.js` com URL estável) guarda em cache só a casca
   da interface: `/studio/`, `manifest.json`, ícones, marca e os assets com
   hash. Tudo sob `/api/` é rede-somente; sem rede, o worker responde
   `503 {"error":"OFFLINE","offline":true}` e a interface mostra a faixa "Você
   está sem internet…". Nenhum dado de projeto entra no cache — política em
   `policy.ts`, testada em unidade, no worker construído e em Chromium real.
2. **Instalável, sem loja e sem push.** `manifest.json` com `scope`/`start_url`
   em `/studio/`, `display: standalone`, ícones 192/512 e *maskable* gerados do
   logotipo oficial (`scripts/build-pwa-icons.mjs`, saídas versionadas). O
   botão "Instalar" aparece só quando o navegador oferece `beforeinstallprompt`.
   Não há push nem servidor de notificações: as notificações são **locais**,
   disparadas pela própria aba quando a criação termina e a aba está em
   segundo plano, com permissão pedida por gesto da pessoa.
3. **Integração mínima e desacoplada.** A interface avisa o fim de uma criação
   com um evento DOM `dz23:generation-finished` (`detail.state`); o módulo PWA
   escuta o evento. `main.tsx` chama `registerStudioPwa()`; `App.tsx` não é
   tocado nesta etapa (o Codex está editando esse arquivo na M1) — a linha que
   dispara o evento entra na integração, conforme o handoff.
4. **Textos em catálogo próprio.** `src/i18n/pwa.pt-BR.json`, para não
   colidir com o catálogo que a M1 edita; o gate de i18n continua estrito
   sobre `apps/studio-web/src`. Os catálogos podem ser fundidos depois.
5. **Chromium reutilizável nas provas.** `DZ23_CHROMIUM_PATH` em
   `playwright.config.ts` aponta um Chromium já instalado (WSL sem download,
   ambiente do Claude) — nenhuma prova baixa navegador.
6. **Sem Lighthouse.** Em vez de adicionar a ferramenta (peso e inventário),
   a prova Playwright verifica os critérios de instalabilidade que ela mede:
   manifesto válido servido, ícones reais, `theme-color`, service worker
   ativo controlando a página, casca carregada sem rede. Auditoria de
   acessibilidade continua pelo axe na jornada.

## Limites verdadeiros

Sem push, sem sincronização em segundo plano, sem cache de dados. Instalação
em Android/Chrome real e em iOS (`apple-touch-icon` presente; Safari não emite
`beforeinstallprompt`) não foram executadas em aparelho físico:
`NOT_EXECUTED`. O preview no celular depende da M1 (HTTPS em domínio real) e
segue `NOT_EXECUTED` com o texto do próprio cartão de preview.
