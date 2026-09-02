# Matriz de capacidades — DZ23 STUDIO

Estados seguem ADR-005 e nunca transformam uma prova focada em “aplicação pronta”.

| Capacidade | Estado | Evidência | Falta para ESTÁVEL |
| --- | --- | --- | --- |
| Núcleo composto sem diff no Harness | BETA | PoC-01b | empacotamento e jornadas reais |
| Identidade, sessão revogável e RBAC | BETA | P29-A/P29-B | PostgreSQL multi-instância e UI final |
| Acesso móvel por borda autenticada | BETA | P29-C: HTTP, RPC e WS reais | celular/Tailscale e domínio reais |
| Bind público da porta interna do Harness | BLOCKED | ADR-012 proíbe | não deve ser liberado |
| TLS ACME em domínio real | NOT_EXECUTED | configuração validada | emissão e renovação reais |
| Deploy de produção | NOT_EXECUTED | nenhum deploy | fase própria com aprovação humana |
