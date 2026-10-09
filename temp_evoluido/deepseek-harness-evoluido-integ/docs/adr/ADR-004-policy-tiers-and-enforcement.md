# ADR-004 — Tiers e aplicação da política no executor

- Estado: Aceita
- Data: 2026-09-02
- Ressalva: implementada na primeira fatia
- Escopo: DZ23 STUDIO P30

## Decisão

O DZ23 STUDIO classifica ações em T0–T3 e aplica a decisão no evento
host-side `tools/pre-execute` do DeepSeek Harness. A interface pode explicar a
decisão, mas não tem autoridade para autorizá-la ou contorná-la.

| Tier | Linguagem para a pessoa | Resultado técnico |
|---|---|---|
| T0 | leitura segura | automático |
| T1 | alteração reversível | automático e auditado |
| T2 | ação externa ou relevante | confirmação humana |
| T3 | ação sensível | identidade forte e nova confirmação |

Regras fechadas:

- ferramenta sem classificação usa T2;
- tier inválido usa no mínimo T2;
- MCP externo nunca fica abaixo de T1;
- `danger-full-access` é sempre T3;
- conflito usa o tier mais restritivo;
- rebaixamento só ocorre quando manifest e policy concordam explicitamente;
- uma classificação inferida T3 nunca pode ser rebaixada;
- T1 só permanece automático quando o sandbox é `read-only` ou
  `workspace-write` e a ação não declara efeito externo; caso contrário, sobe
  para T2;
- plugin não assinado é bloqueado no canal estável;
- regra estruturalmente inválida é bloqueada;
- chamada sem sessão auditável é bloqueada;
- T3 sem identidade forte é bloqueado;
- cada decisão é gravada no domínio Studio `studio_policy_audit`, com
  `org_id`, `tenant_id` e `session_id`, e também é emitida como
  `studio-policy/decision` para observabilidade.

O Harness fixado recusa eventos duráveis declarados por plugins externos porque
seu catálogo `KNOWN_SESSION_EVENT_TYPES` é gerado apenas com pacotes do próprio
repositório; o comentário do upstream informa que o registro downstream ainda
foi adiado. Alterar esse catálogo violaria o zero diff. Por isso, a auditoria
durável pertence ao domínio do Studio, enquanto T2/T3 também geram os eventos
oficiais `approval/asked` e `approval/decided` na sessão.

## Evidência inicial

O pacote `plugins/policy` possui 50 casos de tabela e testes adicionais de
falha fechada. A prova executa o plugin sobre o `ToolRuntime` e o `SessionStore`
reais do Harness fixado, não somente sobre mocks. O gate registrado em
`docs/pocs/P30-policy-engine-proof.md` precisa permanecer verde.

## Limite desta fatia

O motor está construído e montado no profile. O trust plane P29 ainda fornecerá
OIDC/passkeys e a confirmação forte real; até lá, T3 permanece bloqueado por
default. Essa limitação é intencional e segura.
