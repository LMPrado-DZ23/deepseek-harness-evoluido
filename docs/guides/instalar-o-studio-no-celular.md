# Instalar o DZ23 STUDIO no celular ou no computador — guia em linguagem comum (M4)

O Studio pode ser **instalado** como um aplicativo a partir do navegador (é um PWA). Ele
continua rodando no seu computador ou servidor; o que fica no celular é só a "casca" da
interface, sem dados e sem senhas. Estado atual: **BETA** — provado em Chromium no ambiente
de testes; ainda **não** foi testado em um aparelho físico (ver `docs/CAPABILITY_MATRIX.md`).

## O que você vê

- Um botão **"Instalar o DZ23 STUDIO neste aparelho"** aparece quando o navegador permite
  instalar (Chrome e Edge no Android e no computador; no iPhone use "Compartilhar → Adicionar à
  Tela de Início"). Depois de instalado, a interface confirma em palavras.
- **Sem internet**, a tela do Studio ainda abre e uma faixa avisa: "Você está sem internet. O
  Studio continua aberto, mas suas ações vão esperar a conexão voltar." Nenhum dado de projeto é
  guardado no aparelho — só a interface. Ao tentar agir sem rede, a mensagem diz isso em vez de
  mostrar um código.
- **Avisar quando a criação terminar**: durante a criação de um aplicativo, um botão pede sua
  permissão para avisar quando terminar, mesmo com a aba em segundo plano. O aviso é local (não
  há servidor de notificações nem envio para terceiros). Esta parte depende de duas linhas na
  interface principal que entram na integração com a M1; até lá consta como `NOT_IMPLEMENTED`.

## O que NÃO acontece

- O Studio **não** guarda projetos, códigos de acesso nem segredos no celular.
- Instalar **não** publica nada na internet; o aplicativo criado continua só no seu computador
  até você decidir o contrário.
- Não existe loja nem cobrança (ADR-009).

## Para quem opera o servidor

- Os arquivos são `apps/studio-web/public/manifest.json`, ícones em `public/icons/` e o
  service worker em `/studio/sw.js` (construído com versão determinística). Tudo é servido pelo
  próprio Studio, sob a sessão autenticada.
- Para acessar do celular fora do computador, siga `docs/guides/mobile-secure-access.md`
  (borda autenticada; nunca `0.0.0.0`).
- Prova em navegador: `pnpm --dir apps/studio-web test:e2e` (com `DZ23_CHROMIUM_PATH` se o
  Chromium do Playwright não estiver instalado); resultado em `docs/proofs/M4-studio-pwa-proof.md`.
