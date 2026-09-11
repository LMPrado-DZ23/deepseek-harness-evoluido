# Blockers externos

Cada item aqui precisa provar que **o trabalho interno já foi até onde dava**.
"OAuth bloqueado porque não tenho credencial" quando o callback nem existe não é
blocker externo: é trabalho interno pendente com nome errado.

| ID | o que está bloqueado | evidência do bloqueio | trabalho interno já feito | ação humana mínima |
| --- | --- | --- | --- | --- |
| EB-01 | Push, PR e leitura da API do GitHub | `gh api repos/.../commits/integ` → HTTP 403 "GitHub access to this repository is not enabled for this session"; não existe ferramenta `add_repo` nesta sessão | Todo o trabalho é commitado localmente e entregue por bundle git verificado por SHA-256 | Prado dá `git pull` do bundle e `git push origin integ` pelo PowerShell |
| EB-02 | Fase 0.5 — validação com pessoas leigas | Nenhuma pessoa leiga usou o produto | Kit metodológico preservado; `gate:comprehension` mede o que dá para medir sem gente (o brief entendido) e registra 42,9% no conjunto cego | Cinco sessões com pessoas reais, gate 4/5 |
| EB-03 | Instalador `.exe` para Windows | Exige máquina Windows com Docker autorizado | Lifecycle WSL2, rollback, inventário fail-closed, preflight de 18 cenários e criação de segredos 12/12 já provados em simulação; plano em `docs/plans/D-11-o-que-falta-para-ser-um-exe.md` | Assinatura de código (custo financeiro — decisão do Prado) e execução real do lifecycle |
| EB-04 | Provedor de LLM real no caminho de geração | Nenhuma credencial de provedor neste ambiente | Contrato provado por fixture em todo caminho de modelo; `StudioFakeAdapter` é PoC e não entra na imagem | Credencial de provedor, ou Ollama local no computador do Prado |
| EB-05 | Migração de dados em instalação REAL | Não existe instalação que já tenha rodado | Roteiro genérico provado contra PostgreSQL 16 com verificação registro a registro e falsificação adversarial | Uma instalação real com dados |
| EB-06 | Celular físico, TLS em domínio real, deploy de produção | Sem aparelho, sem domínio, sem infraestrutura | Borda autenticada, PWA, manifesto e service worker provados em Chromium real | Aparelho, domínio e autorização de deploy |
