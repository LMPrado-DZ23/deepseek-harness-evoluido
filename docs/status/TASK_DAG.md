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
| T-06 | P1 | `trace_id` correlacionando missão → tarefa → execução → ferramenta | T-05 | DONE (o elo `child_session_id` existe e é falsificado, e a superfície que o consome chegou na OS-53. Limitação declarada: a trilha é varrida inteira por etapa, sem índice) |
| T-07 | P1 | Context Engine: teto, prioridade, deduplicação, procedência, registro | — | DONE (planejador; falta intake e gerador: T-25) |
| T-08 | P1 | Memory Engine — **memória de falha** entregue; as outras seis não existem | — | DONE (T-26: as sete mapeadas, seis EXISTE. A de falha segue PARCIAL de proposito — ela vive em memoria e morre com a execucao, e isso esta DITO no mapa) |
| T-27 | P0 | Revisão adversarial do portão de prévia (superfície mais exposta) e correção dos achados | — | DONE (A, C, D, F, G corrigidos e falsificados; B e E abertos por decisão registrada em OS-14) |
| T-28 | P3 | Superfície que leia a trilha de política e mostre a cadeia equipe → tarefa → execução → ferramenta | T-06 | DONE (OS-53: rota `GET /studio/teams/:id/trace`, o juntar puro em `tool-trace.ts`, e a seção na tela de progresso. Os três estados de elo não colapsam: etapa que não rodou, etapa sem ligação e etapa com ligação são frases diferentes, e a contagem de sem-ligação sai por fora) |
| T-29 | P0 | Revisão adversarial de identidade/sessão, staging/integration-hub e do APLICATIVO GERADO, e correção dos achados | — | DONE (**identidade 9/8 na OS-90** — sete achados novos, inclusive o par start+verify que desfazia o conserto da OS-33 com um status HTTP —, **app gerado 7/8** (a OS-90 fechou o `catch` que transformava banco travado em 'faça login de novo' para sempre; a OS-91 fechou o LOGIN CSRF e a pasta de prévia listável. Resta UM, aceito: o painel de indicadores mostra agregados a qualquer sessão, pela mesma razão de o painel CRUD ser compartilhado), **staging+hub 11/11 na OS-88** — duas revisões independentes leram os dois plugins e os onze achados foram corrigidos com teste próprio, inclusive um SSRF crítico por normalização de host, uma autoridade dividida na assinatura de manifesto v1, e a quarentena global do staging disparada por falha SEM efeito. Os abertos de identidade e do app gerado seguem nomeados em OS-20 e no relatório. A T-29 fecha aqui: as três superfícies foram lidas por inteiro, os achados corrigidos com teste próprio, e o que sobrou está NOMEADO — um achado aceito no painel de indicadores do app gerado, e dois da T-32 que dependem do upstream e de decisão do Prado) |
| T-30 | P1 | Formulário público do app gerado sem limite de taxa: qualquer pessoa enche o banco do dono | T-29 | DONE |
| T-32 | P2 | Achados abertos das cinco revisões adversariais | T-29 | PARCIAL (fechados: trilha apagável, erro cru, quarentena sem saída, autorização de leitura sem escopo, TOCTOU da cópia, assinatura confiada no campo, remoção travada, endereço sem allowlist, contrato de rota morto, vaga de build vazada, `scope_id` colidente, ordenação de artefato, enumeração por passkey, cartão de confirmação colidente, `revokeAllSessions`, `releaseHarnessSession`, oráculo de tempo em `/magic/start`, `secret_ref` visível a `workspace.read` e a matrícula inteira visível a `members.read`. Fechado também o consumo duplo entre PROCESSOS (OS-48), com prova contra PostgreSQL real. Abertos: argumentos da ferramenta fora do cartão (depende do upstream) e balde de rate limit atrás de borda mal configurada — este último documentado no código e no livro mestre, porque fechá-lo troca o contrato de `edgeRequired` e isso é decisão do Prado) |
| T-31 | P2 | Ligar a conferência de ORIGEM do armazenamento de template (assinatura do manifesto) | — | BLOCKED (EB-08: custódia de chave, decisão do Prado) |
| T-26 | P2 | As outras seis memórias (episódica, semântica, procedimental, decisão, avaliação, trabalho) | T-08 | DONE (OS-60 MAPEOU as sete com portao: quatro ja existiam com outro nome — episodica em `studio_runs`/`studio_evidence`, semantica no `AppSpec` e no indice de codigo, avaliacao nos criterios de aceite, trabalho no motor de contexto. Construi-las de novo criaria uma segunda verdade. A PROCEDIMENTAL era a unica ausencia real e fechou na **OS-79**: julgar (OS-69), o que julgar (OS-74) e a quem dizer (OS-79). `gate:memory-map` marca 6 EXISTE e 1 PARCIAL — a de falha, que ainda morre com a execucao) |
| T-25 | P2 | Intake e etapa nova no mesmo motor de contexto | T-07 | DONE |
| T-09 | P2 | Spec Engine: constitution → specify → clarify → plan → tasks → implement → validate → converge | T-08 | DONE (OS-65: medindo antes de escrever, SEIS das oito fases já existiam com outro nome — `specify` é o `AppSpecV1`, `clarify` é o `IntakeEngine`, `plan` é o `PlannerEngine`, `tasks` são as fatias, `implement` são os geradores mais o pipeline, `validate` é o `acceptance.ts`, e `constitution` foi mapeada na OS-62. A ausência real era CONVERGIR, e ela existe: a criação PARA quando uma tentativa escreve o mesmo código e falha igual, sem nunca afirmar que a próxima falharia. Limitação declarada: a convergência vale para a criação de um aplicativo, não para o laço de equipe) |
| T-10 | P2 | Constitution Engine aplicado pelo planner e pelo builder | T-09 | DONE (OS-62 mapeou as catorze clausulas com portao; OS-75 levou as regras ao CONSTRUTOR; **OS-79 levou ao PLANEJADOR** — `planningRules`, da MESMA constante que recusa, no plano e na etapa acrescentada a mao. Falta so cobrir as clausulas que hoje so o portao conhece) |
| T-11 | P2 | Skill Registry com carregamento progressivo | T-07 | DONE (OS-54 o motor, OS-55 o armazenamento, OS-56 a ligacao com o planejamento, OS-64 a procedencia na tela, OS-76 a PORTA, e **OS-80 a TELA**: `SkillBodyForm` confere o tamanho enquanto a pessoa cola e diz por que nao da quando nao da. Limitacao DITA na propria tela: por esta rota so passa texto cujo corpo caiba em 64 KB, e o envio proprio para textos maiores nao existe) |
| T-12 | P2 | Revisão independente + adversarial + convergência | T-09 | DONE (as três existem: a ADVERSARIAL é `assertGeneratedSource` mais `scanGeneratedContent`, a CONVERGÊNCIA fechou na OS-65, e a INDEPENDENTE chegou na OS-66 — o pipeline relê o registro COMO ELE FOI GRAVADO antes de afirmar protótipo verificado, e prova ausente bloqueia como contradição. Limitação declarada: nenhuma contradição é alcançável hoje pelos caminhos normais, fora o registro perdido — a revisão é segundo muro, e o efeito visível é o aviso de critério não automatizado) |
| T-13 | P1 | Prontidão explícita: READY/WAITING/BLOCKED com motivo nomeado | — | DONE (falta levar à tela: T-24) |
| T-14 | P1 | Mission Engine de escopo amplo (hoje o checkpoint cobre uma geração) | T-13 | PARCIAL (o motor existe e é falsificado — `plugins/mission`, OS-40: candidatura antes de conclusão, prova obrigatória, teto que atravessa execuções. já tem domínio físico, repositório e composição no perfil, e o teto aperta no disparo de equipe (OS-42). tem rota HTTP com contrato (OS-43) e TELA com e2e e axe (OS-44). tem TELA COM FORMULÁRIO DE CRIAÇÃO e PROVA REAL em PostgreSQL 16 (OS-51). registrar prova e motivo de bloqueio PELA TELA chegou na OS-52. O motor está completo de ponta a ponta: criar, registrar, marcar, encerrar — com prova contra PostgreSQL real e e2e em quatro tamanhos) |
| T-15 | P2 | Code Intelligence: índice, símbolos, grafo de dependências | T-07 | DONE (OS-57 o motor, OS-58 ligado ao pedido de mudanca, OS-59 lendo DO DISCO, e **OS-82 os apelidos de caminho**: `@/src/...` — que e como o template gerado importa quase tudo — virou aresta de verdade, lida do `tsconfig.json` DO APLICATIVO com o leitor do proprio TypeScript. Falta preencher os arquivos-alvo a partir do plano anterior) |
| T-16 | P2 | Provider adapters reais atrás do gateway | — | BLOCKED (EB-04) |
| T-17 | P3 | Research Engine com procedência de fonte | T-07 | PARCIAL (OS-63: a PROCEDÊNCIA existe e é falsificada — uma nota só entra se o trecho literal estiver na fonte, com hash do conteúdo e validade. Falta a BUSCA: nada vai à rede, e por onde ela sairia é decisão com auditoria) |
| T-18 | P3 | Visual QA com comparação de imagem | — | DONE (OS-68 o motor, OS-73 a LIGACAO, e **OS-89 os TRES TAMANHOS**: a suite gerada fotografa a inicial em celular, tablet e computador, um tamanho vazio reprova mesmo com os outros dois desenhados, e o leitor confere a LARGURA da foto contra o nome dela — uma captura de celular com a largura do computador é o tamanho que nunca foi aplicado, e ela aprovaria o celular descrevendo outra coisa. `compareImages`, sem chamador desde a OS-68, ganhou `progressoVisual`. Limitação declarada: só a tela INICIAL, a comparação entre tamanhos não é pixel a pixel, e `progressoVisual` ainda não está ligado ao laço de tentativas)
| T-19 | P3 | `MAX_MISSION_COST` e orçamento por missão | T-14 | PARCIAL (teto por EQUIPE e teto por MISSÃO existem e são falsificados — `teamSpend` e `missionSpend`. o de missão JÁ APERTA no disparo de equipe (OS-41), mas nenhum perfil fornece a porta ainda. O de CUSTO em dinheiro depende de tabela de preço) |
| T-20 | P4 | Learning Engine com validação antes de virar regra | T-08, T-12 | DONE (OS-69 deu a VALIDACAO, OS-74 deu o que julgar, e **OS-79 LIGOU**: `recoveryNoteFor` fala com quem acabou de ver a criacao falhar, com os dois numeros junto. So regra VALIDADA sai, e a execucao que acabou de falhar conta CONTRA) |
| T-21 | P2 | Taxonomia de sandbox por capacidade, com desconhecido falhando fechado | — | DONE |
| T-22 | P3 | Feature Capability Registry (AVAILABLE→…→OPERATIONAL) provado por health real | T-06 | DONE (OS-67 o motor, OS-70 a ligacao ao endereco de saude que ja existia, OS-72 os achados A2/A3/A4, e **OS-81 o que faltava**: a varredura foi MEDIDA (188 ms com quinhentos projetos, porque `runs(projectId)` lia o repositorio inteiro uma vez por projeto) e virou UMA leitura, e a sondagem de armazenamento passou a perguntar a DOIS dominios, dizendo QUAL falhou. Limitacao dita: os dominios por projeto nao sao sondados, porque eleger um projeto cobaia mede o projeto e nao o armazenamento) |
| T-23 | P1 | Identidade de socket não reciclável (era "estabilizar teste"; virou defeito de segurança) | — | DONE |
| T-24 | P3 | Mostrar o bloqueio por dependência no painel, com o motivo | T-13 | DONE |
| E0 | P1 | **V6 / EVO-01** — decidir sobre os quinze candidatos ANTES de instalar | T-32 | DONE (OS-83: registro em `docs/inventory/candidatos-v6.json`, motor em `scripts/candidate-registry.mjs`, `gate:candidates` e ADR-049. 15 decididos, ZERO instalados, ZERO capacidades perdidas. AT-113 e AT-114 EXECUTADOS, 14 falsificacoes todas pegas) |
| E1 | P1 | **V6 / EVO-02 EVO-03** — marca da empresa em dois formatos, e pacote de marca que nao vira instrucao | E0 | DONE (OS-84: `brand-package.ts` le sem executar e declara perdas; `brand-apply.ts` aplica em dois formatos e recusa travessia entre empresas. AT-115/116/117/118 EXECUTADOS, 23 falsificacoes todas pegas) |
| E2 | P1 | **V6 / EVO-06 EVO-07 EVO-08** — perfis por capacidade, alvos com etapas separadas, atestacao que expira | E1 | DONE (OS-85: sem queda para o host; cinco etapas por alvo; atestacao por igualdade. AT-123 a AT-128 EXECUTADOS, 14 falsificacoes todas pegas) |
| E3 | P1 | **V6 / EVO-04 05 09 10 11** — selecao visual com mapa de tres estados, handoff que nao amplia escopo, rollback que nao promete desfazer efeito externo | E2 | DONE (OS-86: PARCIAL recusa edicao; as quatro qualificacoes nao se promovem; compensacao e operacao NOVA. AT-119 a AT-122 e AT-129 a AT-134 EXECUTADOS, 16 falsificacoes todas pegas) |
| E4 | P1 | **V6 / EVO-12** — retirada sem perder ativo, e ganho medido em vez de presumido | E3 | DONE (OS-87: cinco etapas de saida; segredo no pacote recusado; contrato externo nao e fingido encerrado; `NAO_MEDIDO` de primeira classe. AT-135 e AT-136 EXECUTADOS, 12 falsificacoes todas pegas) |

## Honestidade de escala

Vinte e duas tarefas, e as de P1/P2 são motores inteiros. Isto **não termina em
uma sessão** — e dizer o contrário seria a primeira mentira. O que termina em
uma sessão é uma tarefa `READY` com prova. É assim que o laço anda: uma por vez,
com a suíte inteira entre elas, e este arquivo atualizado para quem retomar.
