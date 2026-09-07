# M81 — saída segura no navegador e cookie obsoleto

Data: 2026-09-06

## Resultado

Estado: **GO no recorte M81**, ainda **BETA no produto**.

A correção fecha os dois limites alcançáveis encontrados depois da M80. A rota
exata `POST /api/studio/identity/logout` pode atravessar o Caddy sem
`forward_auth`, permitindo que um cookie expirado ou já revogado seja apagado.
Isso não remove as cercas do handler: segredo da borda, Host e Origin continuam
validados antes do roteamento. Quando qualquer candidato de cookie corresponde
a uma sessão ativa, o CSRF daquela sessão continua obrigatório e apenas a
sessão autenticada é revogada. Zero candidatos ou somente candidatos inválidos
terminam idempotentemente sem executar mutação privilegiada. Mais de 64
candidatos distintos são recusados.

A interface consulta o estado de sessão e mostra **Sair** somente quando o
servidor responde exatamente `mode: authenticated`. Modo pessoal, resposta
malformada, indisponibilidade e 401 mantêm a ação escondida. A autorização de
prévia já verificava a sessão de origem a cada pedido; o teste agora prova
explicitamente que um cookie de prévia emitido deixa de autorizar logo após a
revogação da sessão ou a perda da permissão no tenant.

## Identidade da mudança

- branch: `codex/m81-signout-browser-e2e`
- base: `3da1aa92d6d72f0aa59e0b6eccc80e609b36e23f`
- commit funcional e navegador: `dd55d6d2150e188fa1f8e302d988a4665f8ba655`
- ponta final com teste negativo adicional: `ac4860e`
- upstream fixado: `deepseek-harness@6c705be1ce6774a000d061da41d1823b03a3d42c`
- staging limpo preservado: `/home/leandro/dz23-gates/m81-signout-clean-dd55d6d`

## Provas executadas

- Chromium real: 3/3 jornadas PASS — saída bem-sucedida, falha do servidor e
  modo pessoal sem botão;
- aplicativo web completo: 63/63 PASS;
- identidade HTTP + autorização de prévia: 76/76 PASS no checkpoint funcional;
- identidade HTTP depois do teste negativo adicional: 20/20 PASS;
- cobertura isolada de `plugins/identity/src/http.ts`: 100% em linhas,
  funções, instruções e ramos;
- build do aplicativo e service worker: PASS;
- build dos plugins de identidade e prévia: PASS;
- build oficial do Harness no clone WSL2/ext4: PASS;
- typecheck agregado: PASS;
- gates i18n, portabilidade, escopo de domínio, rotas de domínio e pin upstream:
  PASS. O clone descartável teve o `origin` normalizado para a URL oficial e o
  gate confirmou commit `6c705be...`, tree `a712eec...` e manifesto
  `862b9278...`.

O primeiro comando de cobertura focada do aplicativo misturou Vitest 3.0.5 com
o provider de cobertura 4.1.8 e foi inválido por ambiente. A suíte completa do
aplicativo passou; a cobertura crítica do handler foi medida separadamente com
versões compatíveis. Esse erro não é apresentado como defeito do produto.

## Auditoria de segurança

- scan: `781b183b-a00b-4c09-9e76-2be9a266b84e`
- faixa imutável:
  `3da1aa92d6d72f0aa59e0b6eccc80e609b36e23f..dd55d6d2150e188fa1f8e302d988a4665f8ba655`
- dez superfícies alteradas contabilizadas;
- resultado: **0 candidatos reportáveis e 0 achados confirmados**;
- cobertura sem lacuna de fonte; a prova física Caddy/Docker permanece
  `NOT_EXECUTED`;
- relatório:
  `C:/Users/zodyp/.codex/security-scans/m81-signout-browser-e2e/dd55d6d2150e188fa1f8e302d988a4665f8ba655_20260907T013616Z_a765w7cs/report.md`.

O TAC consultivo não pôde ser verificado porque o conector não estava ligado.

## Não executado e pendências honestas

- `scripts/prove-edge.mjs` foi ampliado, porém Caddy/Docker real não foi ligado:
  `NOT_EXECUTED`;
- celular físico: `NOT_EXECUTED`;
- consistência de revogação entre múltiplas réplicas e transação física entre
  revogação e auditoria: não provadas;
- limite total de bytes do cabeçalho Cookie depende do runtime/borda; o limite
  da aplicação cobre 64 valores de sessão distintos;
- falhas inesperadas do armazenamento não fingem `signed_out` e não limpam os
  cookies. A política geral de resposta para erros internos permanece fora do
  recorte M81.

Nenhum merge na principal, push, PR, deploy ou operação Docker foi realizado.
