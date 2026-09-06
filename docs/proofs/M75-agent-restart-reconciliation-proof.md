# M75 — Reconciliação segura de agentes após reinício

Estado: **BETA single-process**. Base: M71
`646c47b53ad7c76c0ca3010e6abdd7001aec0ae0`. Implementação isolada em
`codex/m75-agent-restart-reconciliation-v2`; não autoriza merge na principal,
push, PR, deploy, Docker ou exclusão de branch/worktree.

## Capacidade implementada

- gate de prontidão impede delegação antes da reconciliação;
- duas leituras do registro process-local impedem que um reload classifique um
  job vivo como interrupção de processo;
- runs `RUNNING` ficam `FAILED` e leases ativas são liberadas;
- worktree e propostas permanecem disponíveis para conferência;
- escrita parcial mantém o serviço bloqueado;
- tarefas/equipes convergem somente depois de suas runs autoritativas;
- cancelamento pelo Assistente informa `already-finished` para uma run já
  reconciliada, sem enfraquecer identidade, escopo ou propriedade;
- o runtime expõe os relatórios de reconciliação de agentes e equipes.

## Provas executadas no WSL2/ext4

Clone de prova: `/home/leandro/dz23-gates/m75-clean-20260906a`, destacado na
base M71 e contendo somente os 13 arquivos da fatia durante a validação. O pin
do Harness permaneceu
`6c705be1ce6774a000d061da41d1823b03a3d42c`.

- testes focados finais: **122/122 PASS**;
- cobertura dos serviços/índices de agentes, equipes e ponte: **100%** em
  statements, branches, functions e lines;
- `pnpm typecheck`: PASS;
- builds de `agents`, `agent-team` e `assistant-bridge`: PASS;
- i18n: PASS, 12 catálogos e 287 chaves;
- scopes de tenant, 24 rotas de domínio, 13 ferramentas do Assistente,
  portabilidade e pin do upstream: PASS, incluindo as mutações negativas dos
  gates que as possuem.

`pnpm prove:agent-restart` iniciou **três processos Node separados** sobre o
mesmo `DSH_HOME` isolado e o mesmo backend persistente do profile:

1. o primeiro boot registrou uma run e uma tarefa `RUNNING`, uma lease ativa e
   um Git worktree real com uma proposta não commitada;
2. o segundo boot carregou os registros do processo anterior, informou
   `interruptedRuns=1`, `releasedLeases=1`, `updatedTasks=1` e
   `updatedTeams=1`, convergiu para `FAILED`/`NEEDS_ATTENTION` e manteve o
   worktree listado pelo Git com o mesmo conteúdo;
3. o terceiro boot informou zero alterações e preservou os estados terminais,
   provando idempotência entre processos.

Resultado: `decision=GO`, `transport=three-separate-node-processes` e
`worktreePreservedAcrossRestart=true`. O ambiente dos filhos não recebeu
credenciais de provedores; modelos externos ficaram `NOT_EXECUTED`. A prova
remove seu diretório temporário próprio somente depois das três validações.

A suíte cumulativa terminou em **2.028 PASS / 62 SKIP / 5 FAIL**. As cinco
falhas ocorreram em testes pesados e não alterados de `builder-supervisor`:
quatro timeouts de cinco segundos e uma resposta 504 em `unix-server` sob
carga. Os dois arquivos que continham os últimos casos foram então executados
em um worktree intacto da base `646c47b`, com dependências instaladas offline:
**89/89 PASS**. O teste de descritores passou em 4,268 s e o de limite de corpo
e deadline passou em 142 ms. A evidência classifica o resultado cumulativo como
contenção/intermitência fora da M75; não chama a suíte completa de verde.

## Auditoria de segurança

O Security Diff Scan formal cobriu os oito itens de produção da fatia e
terminou com cobertura completa e zero achados. O relatório está em
`C:\Users\zodyp\.codex\security-scans\m75-agent-restart-reconciliation-v2\646c47b53ad7c76c0ca3010e6abdd7001aec0ae0_20260906T174042Z_cxm0kdos\report.md`.
O conector TAC não estava configurado, portanto esse sinal ficou `unknown` e
não foi tratado como aprovação.

Depois do snapshot formal, houve uma única simplificação na cláusula `finally`
que limpa a promessa já concluída; não alterou o contrato. O diff posterior foi
revisto, passou `git diff --check`, typecheck e a prova focada com 100% de
cobertura. Não se afirma que essa linha posterior pertence ao snapshot formal.

## Limites honestos

- M75 termina trabalho interrompido; não retoma o raciocínio nem o processo do
  agente.
- Garantia active-active e coordenação distribuída continuam `NOT_PRESENT`.
- Codex CLI, Claude Code e OmniRoute continuam fora desta prova.
- O reinício de processos foi provado no WSL2/ext4; reinício real no Windows,
  celular, operação prolongada e cinco pessoas leigas continuam pendentes.
- A fatia só pode entrar na principal depois de revisão independente do Claude
  e autorização de merge do Prado.
