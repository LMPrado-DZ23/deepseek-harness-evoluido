# M5 — Prova do Integration Hub v1 no Studio real

- Resultado: **GO** (2026-09-04, ambiente do Claude, Studio real no profile `studio` com o plugin `@dz23-studio/integration-hub`)
- Entrada pelo caminho real: código de acesso por e-mail (captura de desenvolvimento), sessão e CSRF do Studio.
- SMTP do aplicativo gerado: o navegador envia só o **nome** da referência (`DZ23_APP_SMTP`); o valor fica no ambiente do servidor, é conferido (existe + formato) e **não aparece no armazenamento**; nome inexistente → 400; teste de envio → `NOT_EXECUTED` com explicação (provedor ainda não escolhido).
- Registro D16: manifesto assinado (Ed25519) → `verified`, ligado; manifesto não assinado de MCP externo com tier declarado T0 → `unverified`, tier efetivo **T2**, ligar no canal estável → 403.
- Exportação: projeto `VERIFIED_PROTOTYPE` com run `PASSED` → ZIP com 6 entradas (servidor standalone, estáticos, relatório, README em linguagem comum, `.env.example` só com nomes); `data/` e códigos capturados **não** entram; SHA-256 exibido no cabeçalho e igual ao arquivo; segunda exportação produz o mesmo digest.
- Auditoria: 8 eventos com organização e espaço de trabalho, incluindo a recusa.
- Interface `/studio/hub` em Chromium real contra este mesmo Studio: **PASS** ([1A[2K  5 passed (8.3s)) — tela própria em pt-BR; nome do segredo guardado e teste mostrado como não executado; integração sem assinatura sem botão de ligar; pacote gerado pela tela com SHA-256 igual ao download; sem sessão → 401 na tela e na API.

Não executado: envio SMTP real (depende da escolha do provedor pelo Prado), aparelho físico, avaliação com pessoas leigas (ADR-016: só no sistema completo).
