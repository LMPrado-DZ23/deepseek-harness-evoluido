# Estado da missão autônoma — DZ23 STUDIO v1.0

- mission_id: `DZ23-STUDIO-V1-20260904`
- objetivo: concluir o DZ23 STUDIO v1.0 com provas verificáveis, sem verde artificial
- estado: `FIXING` (rodada 3 fechada: os dois CRÍTICOS de regressão, o ALTO, os
  MÉDIOS e os BAIXOS das duas verificações estão fechados com prova; resta o
  blocker interno S-08 e os bloqueios externos)
- iteração: 35
- início: 2026-09-04
- último heartbeat: 2026-09-09
- último progresso real: o `studio_integrations` saiu da chave-valor para a tabela
  por inquilino com RLS (cobertura 1/26 → 2/26), e a classificação dos pendentes
  foi corrigida: 11 dos 12 que se diziam mecânicos não eram. Antes disso, o
  portão real de PostgreSQL voltou a rodar e fechou
  62/62 — a falha que restava era o atalho de teste sendo derrubado pelo próprio
  endurecimento do produto, e o `pg_restore` não dizia por quê. Antes dela, a
  rodada 3 fechou C-N1, C-N2, C-N3, C-N4, C-N5, C-N6, C-N7, C-M1, C-M10, C-2,
  C-H7, B-M1, B-M2, B-M6, B-L1, B-N1, B-N2 e B-N3.
- branch: `integ`
- ponta: ver `git log -1`
- upstream: `deepseek-harness@6c705be1ce6774a000d061da41d1823b03a3d42c`

## Placar objetivo

- v1.0: **112 de 120** (93,3%) em BETA ou STABLE
- suíte raiz: 2741 aprovados, 65 pulados (174 arquivos)
- app: 344 aprovados (38 arquivos)
- typecheck raiz: 0; typecheck do app: 0; build: 0
- portões estáticos: 15/15 PASS
- e2e navegador: **62 aprovados / 5 pulados nos quatro tamanhos** (mesa, tablet,
  celular, faixa estreita de 900px), com axe em modo claro E escuro no fluxo
  inteiro
- PostgreSQL 16 real: **62/62** (`POSTGRES_GATE=PASS server=compose`)
- provas de runtime: assistente (17 ferramentas), reinício de agente, loopback, endurecimento de contêiner

## Fechados nesta rodada

X-11, A-08, S-09, D-02, A-07, H-01, E-05, E-01, P-02, X-07, X-02, E-03, X-04,
X-12 (WebMCP), A-03, A-06, M-03, S-15, P-09, C-24.

## Blockers com dependência externa REAL

| requisito | falta |
| --- | --- |
| C-05 | decisão jurídica do Prado (duas perguntas em `docs/plans/C-05-decisao-de-licenca.md`) |
| P-07 | chave de LLM real |
| S-04 | imagem do Caddy exige `xcaddy build` (módulos Go); contêineres deste ambiente não têm rota para registro de pacote |
| D-10 | mesmo bloqueio de rede do S-04 |
| D-09 | aparelho Android físico (caminho definido: P37 de ARTEMIS pronto) |
| H-11 | conversa longa real que ultrapasse o limiar do Harness — precisa de modelo real |
| U-04 | uma pessoa leiga de verdade |

## Blocker interno

| requisito | estado |
| --- | --- |
| S-08 | FAILED, mas o mapa mudou. Cobertura RLS **2/26** (piso 2): `studio_action_approvals` e `studio_integrations`. Dos 12 que estavam marcados `ready`, **11 não eram mecânicos** — a leitura do código mostrou uma corrente de hash global (`studio_policy_audit`) e uma varredura de início sobre todos os inquilinos em 10 domínios (categoria nova `startup-reconciliation`). Mapa: `ready`=0, `startup-reconciliation`=10, `cross-tenant-invariant`=2, `hot-guard`=4, `tenant-resolution`=6 (IMPOSSÍVEIS por construção), `needs-review`=2. Não há mais trabalho MECÂNICO aqui: o que resta exige decisão de desenho, e o texto do requisito continua precisando de correção — decisão de produto. |

## Próxima ação

`FIXING` → **não resta trabalho interno mecânico**. O S-08 deixou de ser "migrar
12 domínios" e virou duas decisões de produto, ambas do Prado:

1. corrigir o texto do requisito para o alvo alcançável (6 domínios são o que
   RESOLVE o inquilino e não podem ser filtrados por ele);
2. escolher o desenho da varredura de início — enumerar inquilinos, ou uma
   credencial de manutenção com escopo declarado — antes de migrar os 10
   `startup-reconciliation`.

O restante em aberto está tabelado em `audit/FINAL_THREE_AGENT_REVIEW.md`, seção
"Em aberto, com motivo escrito", e cada linha tem o motivo por extenso.

## Instruções de retomada

1. `git log -1` e `git status` — a árvore deve estar limpa;
2. `node scripts/check-requirements-ledger.mjs` — o placar objetivo;
3. `npx tsx scripts/check-rls-coverage.ts --self-test` — o estado do S-08;
4. o S-08 não tem mais trabalho mecânico: `ready`=0. O que resta são as duas
   decisões de desenho descritas em "Próxima ação".
