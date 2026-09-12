# PROJECT_STATUS — DZ23 DEEPSEEK ENGINEERING OS

> **Este é o arquivo de retomada.** Depois de qualquer interrupção — contexto
> compactado, sessão nova, máquina reiniciada — leia ESTE arquivo primeiro,
> depois `EXECUTION_JOURNAL.md`, depois `git status`. Não peça ao Prado para
> explicar o projeto de novo.

- `mission_id`: `ENGINEERING-OS-2026-09-11`
- `mission_intent`: evoluir o repositório para um Engineering OS sobre o DeepSeek Harness, preservando o motor e a compatibilidade com o upstream
- `state`: `EXECUTING`
- `branch`: `integ` (**não é `main`** — confirmar com `git branch --show-current`)
- `head`: ver `git log --oneline -1`; o último estado registrado aqui é `91c6aa0` + o trabalho desta iteração (T-27: revisão adversarial do portão de prévia)
- `harness_upstream_pin`: `6c705be1ce6774a000d061da41d1823b03a3d42c` (zero diff, `gate:upstream-pin` prova)
- `atualizado_em`: 2026-09-12

## O que este repositório É hoje

**Um Prompt-to-App Studio**, não um Engineering OS. Essa é a distância a
percorrer, e nomeá-la é o começo honesto: o produto atual recebe o pedido de
uma pessoa leiga e gera **um aplicativo**. A missão pede um sistema que receba
um repositório e conduza engenharia sobre ele.

Muita coisa do Engineering OS **já existe** e não deve ser reimplementada —
ver `docs/audit/ENGINEERING_OS_CAPABILITY_MATRIX.md`, que mede capacidade por
capacidade com citação de arquivo.

## Baseline medido em 2026-09-11

Todos reproduzíveis pelo comando ao lado.

| verificação | resultado | comando |
| --- | --- | --- |
| typecheck | PASS | `pnpm typecheck` |
| build | PASS | `pnpm build` |
| suíte raiz | 3412 testes, 197 arquivos, 0 falha (12/09, após OS-76) | `pnpm -w test` |
| suíte studio-web | 507 testes | `cd apps/studio-web && npx vitest run` |
| e2e navegador | 117 aprovados, 0 reprovados, 5 pulados (12/09, quatro tamanhos) | `cd apps/studio-web && npx playwright test` |
| PostgreSQL real | **65 testes, `POSTGRES_GATE=PASS`** (12/09, PostgreSQL 16.13 local) | `pnpm test:postgres` |
| portões | **21/21 PASS** | ver abaixo |

Portões, todos `EXIT=0` em 12/09/2026: `domain-scopes`, `domain-routes`,
`assistant-tools`, `team-role-tools`, `rls-coverage` (8/27), `upstream-pin`,
`portability`, `i18n` (26 catálogos, 641 chaves), `comprehension`, `vocabulary` (26 catálogos), `memory-map` (7 memórias, 0 ausentes), `constitution` (14 cláusulas),
`tracked-lib`, `image-lock`, `decision-record` (52 decisões), `requirements-ledger` (235 requisitos),
`secrets` (5.735 arquivos), `no-caveman`, `p37` (12/12),
`vendored-references` (3/3), `licenses` (848 pacotes), `licenses:release`.

## Como abrir o produto

`pnpm studio:doctor` confere o ambiente e devolve **um** comando por vez.
`pnpm studio` dá a partida. A página de uma folha é `docs/COMECAR.md`.

Isto não existia até a OS-77, e a ausência era o defeito mais grave da missão:
quarenta scripts `prove:*`, nenhum `start`, e a primeira execução respondendo
com oito linhas de pilha do Node — exatamente o que o README diz que este
produto existe para não fazer.

## Trabalho desta iteração

1. Remoção de `hasApprovedAncestor` — autorização por linhagem SEM conferir o
   worktree, exportada ao lado da versão correta. Ninguém chamava; o risco era
   o próximo leitor escolher pelo nome mais curto.
2. Remoção de `startDelegation` — porta de entrada pública sem chamador e sem
   teste.
3. Botão "Voltar para este ponto" deixou de aparecer quando voltar é
   impossível. Tabela exaustiva `UNDO_AVAILABLE_BY_STATE` espelha
   `UNDO_TRANSITIONS` do servidor.
4. `CATEGORY_NOT_IMPLEMENTED` saiu do union (nunca era lançado) e as duas
   listas negadas de categoria viraram `CATEGORY_REQUIRES_DATA_MODEL`,
   exaustiva.
5. Os dois `catch {}` do gerador de e-mail — que viajavam para dentro de todo
   aplicativo gerado com formulário — passaram a distinguir arquivo ausente de
   arquivo corrompido.

6. **OS-77 — o produto ganhou porta de entrada.** `pnpm studio` e
   `pnpm studio:doctor`, o doctor puro em `scripts/studio-doctor.mjs`, o
   `.nvmrc` que faltava e `docs/COMECAR.md`. 31 falsificações, todas pegas. A
   partida completa **não** é provada daqui: este contêiner está ele mesmo no
   estado "pacote de arranque não encontrado".

7. **OS-78 — vazamento do texto da habilidade, e o OmniRoute na primeira
   execução.** A listagem devolvia `skill_body` a qualquer `workspace.read`,
   desligada inclusive; agora há uma `publicIntegration` única nas três rotas.
   E as três rotas do perfil (ADR-014) entraram no doctor, com os limites do
   OmniRoute presos por teste. 18 falsificações, todas pegas.

8. **OS-79 — T-10 e T-20 fechados.** As regras do construtor chegaram ao
   PLANEJADOR (um plano não pode mais prometer o que o construtor vai
   recusar), e o Learning Engine falou com alguém pela primeira vez: quando
   uma criação falha, a pessoa lê se aquela falha já foi superada antes — com
   os dois números junto. 13 falsificações, todas pegas; uma delas pegou um
   **comentário meu que mentia** sobre por que a ordem das linhas importava.

9. **OS-80 — T-11 fechado.** A rota do texto de habilidade existia desde a
   OS-76 e **nenhuma tela a chamava**. Agora há tela, e ela confere o tamanho
   enquanto a pessoa cola — o servidor exige o número exato de caracteres, e
   descobrir isso por tentativa e erro numa recusa de servidor é o oposto do
   que este produto promete. 11 falsificações, todas pegas.

10. **OS-81 — T-22 fechado.** A varredura das execuções era **quadrática**:
    `runs(projectId)` lê o repositório inteiro, e o laço sobre os projetos
    fazia isso uma vez por projeto — **188 ms** com quinhentos projetos, num
    endereço que a tela consulta. Virou uma leitura só (10,6 ms). E a sondagem
    de armazenamento passou a perguntar a dois domínios, dizendo qual falhou.

## Próxima ação

Ver `docs/status/TASK_DAG.md`, tarefa de maior prioridade em `READY`.

## Regras que não mudam

- `integ` é a branch; `main` não é.
- Push é do Prado, pelo PowerShell: esta sessão recebe HTTP 403 do GitHub.
- Submódulo `third_party/deepseek-harness` é intocável.
- Nada declarado pronto sem evidência reproduzível.
