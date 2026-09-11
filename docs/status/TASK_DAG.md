# Task DAG — Engineering OS

Grafo, não lista: cada tarefa declara de quem depende, e "qual é a próxima" se
responde olhando o que está `READY`, não o que vem depois na página.

Estados: `PENDING` (existe, dependências abertas) · `READY` (dependências
satisfeitas) · `RUNNING` · `BLOCKED` · `REVIEW` · `DONE`.

Prioridades conforme §215 da missão: **P0** segurança/corrupção/build ·
**P1** core runtime · **P2** spec/skills/memória/revisão · **P3** browser/UX/
avaliação/observabilidade · **P4** polimento.

## Ordem escolhida, e por quê

A missão pede catorze motores. Construí-los na ordem em que aparecem no texto
seria errado: **Context Engine e Memory Engine são a fundação de todos os
outros** — um Spec Engine sem contexto governado produz especificação a partir
de despejo de repositório, que é exatamente o `context rot` que §13 proíbe.

E antes dos dois vem uma tarefa que parece burocrática e não é: **`trace_id`**.
Sem correlação, nenhum dos motores seguintes pode ser medido, e medir é o que
separa este trabalho de acrescentar features.

| ID | P | tarefa | depende de | estado |
| --- | --- | --- | --- | --- |
| T-01 | P0 | Remover autorização morta (`hasApprovedAncestor`, `startDelegation`) | — | DONE |
| T-02 | P0 | Botão de voltar só aparece quando voltar é possível | — | DONE |
| T-03 | P0 | Categoria: tabela exaustiva no lugar de duas listas negadas | — | DONE |
| T-04 | P0 | Gerador de e-mail: distinguir arquivo ausente de corrompido | — | DONE |
| T-05 | P0 | Estado persistente da missão (este arquivo, PROJECT_STATUS, blockers, journal) | — | DONE |
| T-06 | P1 | `trace_id` correlacionando missão → tarefa → execução → ferramenta | T-05 | READY |
| T-07 | P1 | Context Engine: teto, prioridade, deduplicação, procedência, registro | — | DONE (planejador; falta intake e gerador: T-25) |
| T-08 | P1 | Memory Engine — **memória de falha** entregue; as outras seis não existem | — | PARCIAL (T-26) |
| T-26 | P2 | As outras seis memórias (episódica, semântica, procedimental, decisão, avaliação, trabalho) | T-08 | READY |
| T-25 | P2 | Intake e etapa nova no mesmo motor de contexto | T-07 | DONE |
| T-09 | P2 | Spec Engine: constitution → specify → clarify → plan → tasks → implement → validate → converge | T-08 | PENDING |
| T-10 | P2 | Constitution Engine aplicado pelo planner e pelo builder | T-09 | PENDING |
| T-11 | P2 | Skill Registry com carregamento progressivo | T-07 | PENDING |
| T-12 | P2 | Revisão independente + adversarial + convergência | T-09 | PENDING |
| T-13 | P1 | Prontidão explícita: READY/WAITING/BLOCKED com motivo nomeado | — | DONE (falta levar à tela: T-24) |
| T-14 | P1 | Mission Engine de escopo amplo (hoje o checkpoint cobre uma geração) | T-13 | PENDING |
| T-15 | P2 | Code Intelligence: índice, símbolos, grafo de dependências | T-07 | PENDING |
| T-16 | P2 | Provider adapters reais atrás do gateway | — | BLOCKED (EB-04) |
| T-17 | P3 | Research Engine com procedência de fonte | T-07 | PENDING |
| T-18 | P3 | Visual QA com comparação de imagem | — | PENDING |
| T-19 | P3 | `MAX_MISSION_COST` e orçamento por missão | T-14 | PENDING |
| T-20 | P4 | Learning Engine com validação antes de virar regra | T-08, T-12 | PENDING |
| T-21 | P2 | Taxonomia de sandbox por capacidade, com desconhecido falhando fechado | — | DONE |
| T-22 | P3 | Feature Capability Registry (AVAILABLE→…→OPERATIONAL) provado por health real | T-06 | PENDING |
| T-23 | P1 | Identidade de socket não reciclável (era "estabilizar teste"; virou defeito de segurança) | — | DONE |
| T-24 | P3 | Mostrar o bloqueio por dependência no painel, com o motivo | T-13 | DONE |

## Honestidade de escala

Vinte e duas tarefas, e as de P1/P2 são motores inteiros. Isto **não termina em
uma sessão** — e dizer o contrário seria a primeira mentira. O que termina em
uma sessão é uma tarefa `READY` com prova. É assim que o laço anda: uma por vez,
com a suíte inteira entre elas, e este arquivo atualizado para quem retomar.
