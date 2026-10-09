# ADR-038 — Reconciliação de agentes após reinício

- Estado: Aceita
- Data: 2026-09-06
- Ressalva: para BETA single-process em M75
- Numero compartilhado com: ADR-038-assistant-multiuser-boundary, ADR-038-immutable-staging-core

## Contexto

As execuções de agente e de equipe são persistidas, mas os handles do registro
de jobs pertencem ao processo do Harness. Depois de um reinício real não existe
processo filho que possa ser retomado ou cancelado. Antes de M75, um registro
`RUNNING` ou uma lease ativa podia continuar parecendo trabalho vivo, enquanto
o cancelamento da conversa falhava sem distinguir uma execução já reconciliada.

Retomar automaticamente um agente a partir desse estado não é seguro: não há
prova de continuidade do processo, do contexto do modelo ou dos efeitos que ele
possa ter produzido. A autoridade persistente precisa convergir para um estado
terminal antes de admitir trabalho novo.

## Decisão

O plugin `agents` executa uma reconciliação obrigatória antes de publicar o
serviço:

1. bloqueia novas delegações;
2. recusa a reconciliação se o registro process-local ainda contém um job
   `studio-agent` em `running` ou `stopping`;
3. fotografa, em ordem determinística, runs persistidas `RUNNING` e leases
   ativas;
4. verifica novamente a inexistência de jobs vivos antes da primeira mutação;
5. transforma cada run interrompida em `FAILED`, libera cada lease ativa e
   preserva o worktree e qualquer proposta já produzida;
6. confirma no repositório que nenhum estado ativo sobreviveu. Escrita parcial
   ou job que aparece durante o fechamento mantém o serviço bloqueado.

Chamadas concorrentes compartilham a mesma promessa de reconciliação. O
relatório resultante fica disponível em `restartReconciliation` no runtime do
plugin. Essa operação é convergente e pode ser repetida: depois de concluída,
uma nova execução informa zero itens interrompidos.

O plugin `agent-team` roda depois do plugin de agentes. Ele somente reconcilia
tarefas `RUNNING` quando a run vinculada já é terminal ou desapareceu. Uma run
ainda `RUNNING` bloqueia a composição. Tarefas passam ao estado terminal real
da run, ou a `FAILED` com diagnóstico de processo perdido; o estado da equipe é
então recalculado. Equipes já `COMPLETED` ou `CANCELLED` não são reescritas.

Na ponte do Assistente, cancelar uma run que já foi reconciliada devolve
`already-finished`. Uma run que ainda declara `RUNNING` mas não possui handle
ativo continua falhando fechada com `CANCEL_UNAVAILABLE`. Organização, tenant,
projeto e autor da aprovação continuam sendo verificados antes dessa decisão.

## Consequências e limites

- Reinício verdadeiro converge o estado persistido sem fingir retomada.
- Worktrees e propostas são preservados para revisão humana; nenhum diff é
  aplicado automaticamente.
- Um reload do plugin no mesmo processo não pode transformar job vivo em
  falha persistida.
- A garantia é single-process. Active-active, retomada do modelo, recuperação
  de um processo remoto e reconexão a Codex/Claude externos continuam
  `NOT_PRESENT` ou `NOT_CONFIGURED`.
- A reconciliação não substitui políticas futuras de limpeza de worktrees.

## Evidência exigida

- runs e leases órfãs convergem em ordem determinística;
- duas chamadas simultâneas compartilham um único resultado;
- jobs vivos no primeiro ou no segundo exame impedem qualquer mutação;
- escrita persistente incompleta mantém o serviço fechado;
- equipes com run terminal, ausente e ainda ativa seguem os três caminhos;
- cancelamento diferencia run reconciliada de run ativa sem handle;
- três processos reais e separados comprovam semeadura persistente,
  reconciliação no boot seguinte e idempotência no terceiro boot;
- testes focados e cobertura crítica em 100%; typecheck, builds, i18n,
  contratos de domínio, ferramentas, portabilidade e pin do upstream verdes;
- suíte cumulativa registrada integralmente, sem atribuir falhas de outro
  componente à M75.
