# ADR-008 — Step-up com passkey para ações sensíveis

- Status: Aceito
- Data: 2026-09-02

## Decisão

Uma ação T3 só pode chegar à confirmação humana quando a sessão:

1. continua autenticada e não revogada;
2. realizou WebAuthn com `userVerification: required`;
3. confirmou biometria ou PIN nos últimos cinco minutos.

Código por e-mail não satisfaz identidade forte. O estado entregue ao P30 contém
dois fatos independentes: `authenticated` e `strongIdentityVerified`. O primeiro
protege todas as ferramentas; o segundo é o requisito adicional de T3.

Contador regressivo de autenticador é rejeitado como possível clone. Challenges
têm cinco minutos, uso único e apenas o hash é persistido.

## Evidência

Testes cobrem contador regressivo, challenge expirado/reutilizado, ausência de
UV, janela de cinco minutos e revogação antes da próxima tool call. A cerimônia
real com hardware permanece `NOT_EXECUTED` até existir a UI de navegador.
