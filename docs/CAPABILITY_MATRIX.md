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
| Domínios Studio em PostgreSQL | BETA | P31-A: contrato KV, durabilidade e falha fechada reais | carga, backup/restore e servidor real |
| Escritor único cross-process | BETA | P31-A: dois processos e SIGKILL | operação prolongada e observabilidade |
| Multi-instância ativa/standby quente | BLOCKED | ADR-013: estado autoritativo em memória | contrato de fencing/reload upstream |
| RLS PostgreSQL por tenant | NOT_PRESENT | KV armazena JSON opaco | repositório tenant-aware + role sem BYPASSRLS |
| Transação de negócio multi-registro | NOT_PRESENT | contrato KV é atômico por chamada | extensão batch/CAS transacional |
| Migração SQLite lógica | BETA | bundle versionado e E2E focado P31-A | restore operacional e dataset real |
