# M5 — Prova do Integration Hub v1 no Studio real

- Resultado: **GO** (2026-09-04, ambiente do Claude, Studio real no profile `studio` com o plugin `@dz23-studio/integration-hub`)
- Sessão obtida pelo serviço de identidade real em processo (código de acesso por e-mail, captura de desenvolvimento); as chamadas ao Hub passam pelo servidor HTTP real com sessão e CSRF.
- SMTP do aplicativo gerado: o navegador envia só o **nome** da referência (`DZ23_APP_SMTP`); o valor fica no ambiente do servidor, é conferido (existe + formato) e **não aparece no armazenamento**; nome inexistente → 400; teste de envio → `NOT_EXECUTED` com explicação (provedor ainda não escolhido).
- Registro D16: manifesto assinado (Ed25519) → `verified`, ligado; habilidade **sem assinatura** declarando T0 → `unverified`, tier efetivo **T2** (piso de não verificado, sem envolver rede), ligar no canal estável → 403; manifesto adulterado → 400 e evento de recusa; `can_enable` decidido pelo servidor.
- Exportação: projeto levado a `VERIFIED_PROTOTYPE` por `transition()` e run `PASSED` **simulada** (standalone fabricado com `server.js` de uma linha; o pipeline real de geração não foi executado nesta prova) → ZIP com 7 entradas; `data/` da raiz do app (sqlite + códigos capturados) e `.env` **não** entram, enquanto `node_modules/lib/data/` entra; SHA-256 no cabeçalho igual ao arquivo; segundo pedido devolve o mesmo pacote (sem arquivo gêmeo); arquivo sumido → 404 sem caminho do servidor.
- Auditoria: 8 eventos com organização e espaço de trabalho, incluindo a recusa.
- Interface `/studio/hub` em Chromium real contra este mesmo Studio: **PASS** (  5 passed (8.6s) (5 passed, 0 skipped)) — tela própria em pt-BR; nome do segredo guardado e teste mostrado como não executado; integração sem assinatura sem botão de ligar; pacote gerado pela tela com SHA-256 igual ao download; sem sessão → 401 na tela e na API.

Não executado: envio SMTP real (depende da escolha do provedor pelo Prado), exportação de um standalone real produzido pelo pipeline (fica para a integração com a M1/fatia 3), aparelho físico, avaliação com pessoas leigas (ADR-016: só no sistema completo).
