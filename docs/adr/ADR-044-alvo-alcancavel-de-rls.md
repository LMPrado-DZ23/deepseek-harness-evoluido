# ADR-044 — O alvo de RLS corrigido para o que é alcançável

Data: 09/09/2026. Estado: aceito, **reversível enquanto ninguém tiver instalado**.
Autor: Claude (Opus 5), dentro da autonomia delegada por Prado
("faça tudo até não restar nada que você possa fazer").
Requisito correspondente: `S-08`.

## Contexto

O `S-08` pede, com estas palavras: *"PostgreSQL 16 com ENABLE/FORCE RLS,
`org_id` e `tenant_id` em TODA tabela"*.

Dois domínios migraram (`studio_action_approvals`, `studio_integrations`). Os
outros 24 estão classificados, um a um, com o motivo e a citação do código que
sustenta o motivo — e o `gate:rls-coverage` reprova classificação sem citação, e
citação que aponta para símbolo ou arquivo que não existe.

Lendo essa tabela inteira, a conclusão é desconfortável: **o requisito, como
escrito, não é alcançável — e não por falta de trabalho.**

## O que a classificação diz

**8 domínios são o que RESOLVE o inquilino.** `studio_identity_users`,
`studio_identity_sessions`, `studio_identity_audit`, `studio_orgs`,
`studio_workspaces`, `studio_memberships`, `studio_previews`,
`studio_preview_admissions`.

Filtrar essas tabelas por `tenant_id` é pedir a resposta antes da pergunta. O
caso da prévia foi o último a ser conferido, e é o mais claro de todos:
`authorize(hostname, cookie)` roda no portão, em toda requisição que chega em
`<algo>.preview.<host>`, e acha a prévia **pelo nome de host** — sem ator, sem
escopo. O inquilino é exatamente o que essa busca está descobrindo.

**4 são guardas SÍNCRONOS no caminho quente.** `studio_emergency_stop`
(`assertRunning`, antes de cada delegação e de cada chamada de integração),
`studio_integration_switches` (`assertScopeEnabled`, antes de qualquer saída),
`studio_agent_leases` (conflito de caminhos, antes de cada delegação),
`studio_route_health` (a cada requisição de modelo). Uma leitura de banco é
assíncrona; esses pontos não são. Migrar exige trocar a forma da chamada em
lugares onde uma espera nova muda o comportamento — é redesenho, não migração.

**2 têm invariante ENTRE inquilinos.** `studio_policy_audit` é uma corrente de
hash **global**: `seq` e `previous_sha256` encadeiam entradas de todos os
inquilinos, e `verifyPolicyAuditChain` só fecha lendo a corrente inteira.
`studio_staging_releases` prende o destino físico ao primeiro escopo que o
reservou — ver essa colisão exige ler releases de outros inquilinos, que é
precisamente o que a RLS impede. Nos dois, a RLS **quebraria a garantia**.

**10 estão presos à varredura de reinício.** E aqui a classificação precisa ser
lida com cuidade, porque ela separa duas coisas diferentes:

- `studio_runs`, `studio_projects` e `studio_approvals` são LIDOS OU ESCRITOS
  pela varredura sem ator (`reconcileInterruptedExecutions`), que existe para
  não deixar execução fantasma depois de um reinício;
- `studio_app_specs`, `studio_design_specs`, `studio_intake_turns`,
  `studio_plans` e `studio_evidence` **não são tocados pela varredura**. Eles
  estão pendentes por morarem no mesmo `PromptToAppRepository`, cujas leituras
  são síncronas e sem escopo. Migrar um sem os outros parte o repositório em
  dois donos.

## Decisão

**O alvo do `S-08` passa a ser 7 de 26, e não 26 de 26.**

- **2 migrados** hoje;
- **5 alcançáveis** — os cinco de `prompt-to-app` fora da varredura, com o plano
  em `docs/plans/S-08-migracao-restante.md`;
- **19 excluídos por razão estrutural nomeada**, cada um com citação de código
  no `gate:rls-coverage`.

Os 19 não viram "pendente para sempre": eles viram **exclusão declarada**. A
diferença importa. "Pendente" convida alguém a tentar de novo daqui a seis meses
e descobrir sozinho o mesmo beco; "excluído porque a identidade não pode ser
filtrada por si mesma" é uma decisão que se lê em dez segundos.

Três dos 19 (`runs`, `projects`, `approvals`) deixam de ser excluídos **se** a
varredura de reinício for redesenhada para rodar por inquilino — o que exige
enumerar inquilinos, que é uma consulta de resolução de escopo. Isso é uma
decisão de arquitetura futura, e está escrita como tal.

## Por que isto NÃO é baixar a régua

Porque o número que sobe não é o que protege ninguém. O que protege é:

1. a classificação de cada domínio, com citação **conferida** pelo portão;
2. o piso `RLS_MIGRATED_FLOOR`, que impede o número de cair;
3. o isolamento por código, que continua valendo em todos os 26 e é provado por
   teste em cada plugin.

Deixar o alvo em 26 fazia o requisito parecer 92% incompleto quando a verdade é
que 19 dos 26 **nunca deveriam** migrar. Um requisito que mede a coisa errada
não é rigoroso: ele é ruído que ensina a ignorar o painel.

## O que esta ADR NÃO decide

Ela não migra nada. Os cinco alcançáveis continuam **não migrados**, e o
`S-08` continua `FAILED` até que eles migrem e a prova exista. O que ela muda é
o denominador — e o motivo de cada exclusão, que antes vivia só na cabeça de
quem tinha lido a tabela inteira.

Ela também não afirma que a decisão é minha para sempre: o Prado pode manter o
alvo em 26 e registrar os 19 como impossíveis, o que dá o mesmo resultado com
outra contabilidade. Enquanto o repositório for privado e ninguém tiver
instalado, a escolha é reversível.
