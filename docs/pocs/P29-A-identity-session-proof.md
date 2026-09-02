# P29-A — Prova de identidade e sessão

- Data: 2026-09-02
- Branch: `codex/p29a-identity-session`
- Base: `c616595`
- Upstream: `6c705be1ce6774a000d061da41d1823b03a3d42c`
- Ambiente canônico: WSL2, ext4 em `/home/leandro/dz23-studio-p29a-20260902`

## Resultado

**GO limitado para o núcleo de identidade/sessão.** O trust plane completo ainda
não existe: P29-B (org/workspace/RBAC), P29-C (borda) e a cerimônia real de
passkey no navegador continuam pendentes.

Implementado:

- usuários, credenciais WebAuthn, sessões, challenges, códigos e auditoria em
  domínios tipados do Studio;
- código de seis dígitos com 10 minutos, cinco tentativas e uso único;
- SMTP por referência de segredo e capturador somente em memória para loopback;
- token opaco de 32 bytes, hashes, cookies seguros, CSRF duplo, 14/90 dias;
- dispositivos, revogação individual/global e vínculo com sessão do agente;
- WebAuthn normal e step-up UV, com rejeição de contador regressivo;
- `authenticated` e `strongIdentityVerified` consultados no hook autoritativo do
  P30 antes de cada ferramenta;
- rotas de identidade em linguagem simples e allowlist de Host/Origin.

## Verificações reais

Na cópia limpa WSL2/ext4:

- `pnpm typecheck`: PASS;
- `pnpm test:coverage`: 107/107 PASS;
- statements/branches/functions/lines: 100%;
- `pnpm build`: PASS;
- `pnpm prove:runtime`: GO;
- sessão de identidade restaurada após reinício;
- sessão revogada bloqueou a próxima chamada de `studio_echo`;
- nenhum token, CSRF ou código apareceu nos registros duráveis inspecionados;
- sessão do Harness, auditoria de policy e sandbox Bubblewrap continuaram válidos.

Dump real mostrou `dz23-studio-policy`, `dz23-studio-identity` e `studio-hello` no
profile, com host padrão `127.0.0.1`.

O gate P37 passou sem caminho proibido. Dependências novas e justificadas:

- `@simplewebauthn/server` 13.3.2 (MIT);
- `nodemailer` 9.0.5 (MIT-0), versão publicada em 07/08/2026 e escolhida para não
  furar a janela mínima de idade da cadeia de suprimentos;
- `@types/nodemailer` 8.0.1 (MIT, desenvolvimento).

## Estados verdadeiros

- núcleo identidade/sessão: `PASS`;
- SMTP real: `NOT_CONFIGURED`;
- cliente `@simplewebauthn/browser`: `NOT_PRESENT`;
- passkey com autenticador físico: `NOT_EXECUTED`;
- proteção global em bind público: `BLOCKED` pelo seam HTTP ausente e destinada
  ao P29-C; bind público continua proibido;
- P29-B e P29-C: `NOT_EXECUTED`.

## Próximo gate

P29-B: `org -> workspace (tenant) -> project`, papéis sem qualquer conceito de
faturamento, isolamento adversarial e declaração estrutural de permissão/tenant.
