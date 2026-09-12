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
| T-06 | P1 | `trace_id` correlacionando missão → tarefa → execução → ferramenta | T-05 | PARCIAL (o elo que FALTAVA — `child_session_id` — existe e é falsificado; a consulta não tem superfície que a consuma: T-28) |
| T-07 | P1 | Context Engine: teto, prioridade, deduplicação, procedência, registro | — | DONE (planejador; falta intake e gerador: T-25) |
| T-08 | P1 | Memory Engine — **memória de falha** entregue; as outras seis não existem | — | PARCIAL (T-26) |
| T-27 | P0 | Revisão adversarial do portão de prévia (superfície mais exposta) e correção dos achados | — | DONE (A, C, D, F, G corrigidos e falsificados; B e E abertos por decisão registrada em OS-14) |
| T-28 | P3 | Superfície que leia a trilha de política e mostre a cadeia equipe → tarefa → execução → ferramenta | T-06 | PENDING |
| T-29 | P0 | Revisão adversarial de identidade/sessão, staging/integration-hub e do APLICATIVO GERADO, e correção dos achados | — | RUNNING (identidade 2/8, app gerado 3/8, staging+hub 0/12 — os abertos estão nomeados em OS-20 e no relatório) |
| T-30 | P1 | Formulário público do app gerado sem limite de taxa: qualquer pessoa enche o banco do dono | T-29 | DONE |
| T-32 | P2 | Achados abertos das cinco revisões adversariais | T-29 | PARCIAL (fechados: trilha apagável, erro cru, quarentena sem saída, autorização de leitura sem escopo, TOCTOU da cópia, assinatura confiada no campo, remoção travada, endereço sem allowlist, contrato de rota morto, vaga de build vazada, `scope_id` colidente, ordenação de artefato, enumeração por passkey, cartão de confirmação colidente, `revokeAllSessions`, `releaseHarnessSession`, oráculo de tempo em `/magic/start`, `secret_ref` visível a `workspace.read` e a matrícula inteira visível a `members.read`. Fechado também o consumo duplo entre PROCESSOS (OS-48), com prova contra PostgreSQL real. Abertos: argumentos da ferramenta fora do cartão (depende do upstream) e balde de rate limit atrás de borda mal configurada — este último documentado no código e no livro mestre, porque fechá-lo troca o contrato de `edgeRequired` e isso é decisão do Prado) |
| T-31 | P2 | Ligar a conferência de ORIGEM do armazenamento de template (assinatura do manifesto) | — | BLOCKED (EB-08: custódia de chave, decisão do Prado) |
| T-26 | P2 | As outras seis memórias (episódica, semântica, procedimental, decisão, avaliação, trabalho) | T-08 | PARCIAL (a memória de DECISÃO existe e é falsificada — `scripts/decision-record.mjs` mais o portão `decision-record`, registrada em OS-39 e na ADR-047. As outras cinco não existem) |
| T-25 | P2 | Intake e etapa nova no mesmo motor de contexto | T-07 | DONE |
| T-09 | P2 | Spec Engine: constitution → specify → clarify → plan → tasks → implement → validate → converge | T-08 | PENDING |
| T-10 | P2 | Constitution Engine aplicado pelo planner e pelo builder | T-09 | PENDING |
| T-11 | P2 | Skill Registry com carregamento progressivo | T-07 | PENDING |
| T-12 | P2 | Revisão independente + adversarial + convergência | T-09 | PENDING |
| T-13 | P1 | Prontidão explícita: READY/WAITING/BLOCKED com motivo nomeado | — | DONE (falta levar à tela: T-24) |
| T-14 | P1 | Mission Engine de escopo amplo (hoje o checkpoint cobre uma geração) | T-13 | PARCIAL (o motor existe e é falsificado — `plugins/mission`, OS-40: candidatura antes de conclusão, prova obrigatória, teto que atravessa execuções. já tem domínio físico, repositório e composição no perfil, e o teto aperta no disparo de equipe (OS-42). tem rota HTTP com contrato (OS-43) e TELA com e2e e axe (OS-44). tem TELA COM FORMULÁRIO DE CRIAÇÃO e PROVA REAL em PostgreSQL 16 (OS-51). registrar prova e motivo de bloqueio PELA TELA chegou na OS-52. O motor está completo de ponta a ponta: criar, registrar, marcar, encerrar — com prova contra PostgreSQL real e e2e em quatro tamanhos) |
| T-15 | P2 | Code Intelligence: índice, símbolos, grafo de dependências | T-07 | PENDING |
| T-16 | P2 | Provider adapters reais atrás do gateway | — | BLOCKED (EB-04) |
| T-17 | P3 | Research Engine com procedência de fonte | T-07 | PENDING |
| T-18 | P3 | Visual QA com comparação de imagem | — | PENDING |
| T-19 | P3 | `MAX_MISSION_COST` e orçamento por missão | T-14 | PARCIAL (teto por EQUIPE e teto por MISSÃO existem e são falsificados — `teamSpend` e `missionSpend`. o de missão JÁ APERTA no disparo de equipe (OS-41), mas nenhum perfil fornece a porta ainda. O de CUSTO em dinheiro depende de tabela de preço) |
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
