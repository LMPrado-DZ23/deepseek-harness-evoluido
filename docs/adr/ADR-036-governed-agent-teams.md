# ADR-036 — Equipes de agentes governadas

- Estado: Aceita
- Data: 2026-09-06
- Ressalva: para BETA em M70

## Contexto

O DZ23 STUDIO precisa permitir que uma pessoa distribua trabalho entre vários
assistentes sem entregar a eles autoridade sobre o repositório principal. O
experimento `agent-team` do Harness e o Hermes são referências de capacidade,
mas não são autoridade de segurança nem dependências da v1.0.

## Decisão

O Studio mantém um coordenador próprio sobre `StudioAgentService`, que continua
sendo a única autoridade para criar worktrees, iniciar runs, reservar caminhos,
produzir propostas e aplicar diffs. Uma equipe tem de 1 a 8 tarefas e usa um DAG
persistido no domínio físico `studio_agent_teams`, nome lógico
`studio.agent.teams`.

Tarefas sem dependência podem iniciar juntas somente quando seus caminhos
declarados não se sobrepõem. Uma tarefa dependente só pode iniciar depois que
todas as predecessoras estiverem no estado `APPLIED`: ver uma proposta não é
suficiente. O avanço é solicitado pela pessoa e confirmado novamente; início
automático de dependentes é `NOT_PRESENT` nesta fatia.

Cada tarefa usa exclusivamente `spawn-in-process`, um worktree isolado e os
limites do serviço de agentes. Operações comuns exigem T2. Segredos, rede externa
ou deploy exigem T3 e a operação exata fica persistida. Não existe auto-apply:
cada proposta passa pelas ferramentas existentes de revisão e aplicação, com
nova confirmação T2.

Os papéis `implementer`, `reviewer`, `tester` e `synthesizer` são instruções
fechadas, não permissões. Organização, tenant, workspace, repositório, usuário,
papel e caminhos permitidos vêm da sessão e da configuração administrativa do
servidor, nunca de campos livres do modelo.

## Consequências e limites

- A v1.0 pode executar trabalho paralelo local e um fluxo dependente aprovado
  pela pessoa sem incorporar código do Hermes.
- O domínio registra equipe e tarefas; jobs vivos ainda pertencem ao processo.
  Retomada automática após reinício continua `NOT_PRESENT` e deve falhar fechada.
- Falha parcial de persistência na criação não tem transação multi-registro no
  seam KV atual; por isso a capacidade permanece BETA.
- Codex CLI, Claude Code, consenso automático, síntese automática, auto-apply e
  coordenação distribuída continuam `NOT_CONFIGURED` ou `NOT_PRESENT`.
- O estado só poderá subir após PostgreSQL real, reinício, jornada no navegador
  e revisão independente.
