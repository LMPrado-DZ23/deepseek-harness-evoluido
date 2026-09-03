# P32 — Interface em navegador, sessão e acessibilidade

- Resultado: **PASS** (`2/2` testes Playwright).
- Servidor HTTP efêmero real: PASS.
- `/studio` sem sessão: `401`.
- `/api/studio/apps/health` sem sessão: `401`.
- Sessão e CSRF na jornada autenticada: PASS.
- Jornada: Ideia → Perguntas → Plano → pedido de mudança → plano revisado →
  aprovação → Criação → Verificação: PASS.
- Texto de privacidade local e identificação da rota `ollama-local`: PASS.
- Estado final visível: `VERIFIED_PROTOTYPE`, acompanhado do aviso de não publicação.
- Auditoria axe no estado final: zero violações.
- Execução: contêiner Playwright fixado, `--network none`, usuário não root,
  `CapDrop=ALL`, `no-new-privileges`, raiz somente leitura e limites de CPU,
  memória, processos e memória compartilhada.

A API deste E2E é determinística e roda em memória. Os contratos reais da API,
CSRF, sessão, papéis e isolamento adversarial entre tenants são cobertos pela
suíte do plugin e pela prova da fatia. Este teste não usa LLM real, não abre
preview e não publica nada.
