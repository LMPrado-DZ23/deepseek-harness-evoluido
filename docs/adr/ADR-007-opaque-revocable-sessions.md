# ADR-007 — Sessões opacas, revogáveis e ligadas ao dispositivo

- Status: Aceito
- Data: 2026-09-02

## Decisão

Sessões usam um token aleatório de 32 bytes, entregue uma única vez e persistido
somente como SHA-256. Não se usa JWT como sessão. Cada registro possui pessoa,
organização, tenant, dispositivo, user-agent, IP truncado, criação, último uso,
expiração deslizante de 14 dias, expiração absoluta de 90 dias e revogação.

Cookies são `HttpOnly; Secure; SameSite=Lax; Path=/`. Toda mutação autenticada
exige o padrão double-submit CSRF. Revogar um dispositivo, inclusive durante uma
execução, faz o resolver de identidade do `tools/pre-execute` devolver
`authenticated=false`; a chamada seguinte é negada antes da ferramenta.

Os domínios físicos são:

- `studio_identity_users`;
- `studio_identity_credentials`;
- `studio_identity_sessions`;
- `studio_identity_audit`.

Seus nomes lógicos seguem ADR-001. Auditoria é append-only e nunca recebe token,
CSRF, código temporário, challenge ou chave privada.

## Limitação conhecida

O backend atual é de processo único. A migração futura para execução concorrente
em múltiplos processos deve trocar consumo de código/challenge por comparação e
troca atômicas no Postgres.
