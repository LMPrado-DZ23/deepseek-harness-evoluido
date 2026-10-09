# P30 — Prova do motor de permissões

- Data: 2026-09-02
- Resultado: GO da primeira fatia P30
- Ambiente canônico: WSL2 Ubuntu, ext4
- Upstream: `deepseek-ai/deepseek-harness` em
  `6c705be1ce6774a000d061da41d1823b03a3d42c`

## O que foi construído

- pacote TypeScript + Zod `@dz23-studio/policy`;
- classificação T0–T3;
- regra mais restritiva em conflitos;
- rebaixamento bilateral explícito;
- bloqueio de plugin não assinado no canal estável;
- mínimo T1 para MCP externo;
- T3 obrigatório para `danger-full-access`;
- T2 para tier ausente ou inválido;
- bloqueio de T3 sem identidade forte;
- bloqueio de execução sem sessão auditável;
- integração no `tools/pre-execute` real;
- auditoria durável no domínio `studio_policy_audit`, separada do log de sessão
  e sem argumentos ou segredos;
- evento runtime `studio-policy/decision` para observabilidade.

## Evidência executada

```text
pnpm typecheck       PASS
pnpm test:coverage   73 PASS
pnpm build           PASS
release license gate PASS (403 arquivos, zero achado)
```

Cobertura de `plugins/hello/src` e `plugins/policy/src`:

```text
statements 100%
branches   100%
functions  100%
lines      100%
```

A suíte contém 55 casos tabulares de policy e 14 provas adicionais no pacote
de segurança, além dos quatro testes preservados do PoC-01. Uma das provas
inicializa `Context`, `SystemPrompt`, `SessionStore` e `ToolRuntime` reais do
Harness, executa uma ferramenta T0 e verifica a auditoria persistida; em
seguida, comprova que uma ferramenta sem classificação não é despachada sem
aprovação. A prova live do profile reinicia o Harness e confirma a restauração
do domínio de auditoria.

O primeiro desenho tentou acrescentar um tipo de evento ao log de sessão. A
prova real recusou corretamente a restauração porque o upstream ainda não
oferece registro de tipos duráveis para plugins externos. A implementação foi
corrigida para o domínio próprio antes do commit; nenhum arquivo upstream foi
alterado.

## Limitação honesta

OIDC/passkeys e sessão de dispositivo revogável pertencem ao P29 e ainda não
foram construídos. Portanto, o motor não finge identidade forte: toda ação T3
fica bloqueada até o trust plane fornecer essa evidência.
