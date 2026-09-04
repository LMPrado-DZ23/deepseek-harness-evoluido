# M4 — Prova da interface do Studio como PWA

- Resultado: **PASS** (Chromium real no ambiente do Claude, 04/09/2026)
- `apps/studio-web` unitários: 13/13 — política de cache (só casca, nunca `/api/`), worker construído (install/activate/fetch com `fetch` e `caches` simulados: 503 `OFFLINE` sem rede, assets cache-first, casca network-first com fallback), notificações locais (mensagens do catálogo, só com permissão e aba oculta).
- Playwright `apps/studio-web` 5/5 em Chromium: jornada original com axe intacta; manifesto instalável servido com três ícones PNG reais, escopo `/studio/`, `theme-color`; service worker registrado e controlando a página; **recarga sem rede mostra a casca com a faixa "Você está sem internet…"** e o cache não contém nenhuma entrada `/api/`; notificação local disparada pelo evento `dz23:generation-finished` com a aba oculta.
- Gates: `gate:i18n` PASS (catálogo PWA separado; sem texto pt-BR fora de catálogo), typecheck PASS, build com `sw.js` em URL estável.

Não executado: instalação em aparelho físico (Android/iOS), Lighthouse (substituído pelas verificações acima), preview no celular (M1/HTTPS).
