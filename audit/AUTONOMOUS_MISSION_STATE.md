# Estado da missão autônoma — DZ23 ENGINEERING OS

> Este arquivo é o ponto de retomada. Quem continuar o trabalho lê ele PRIMEIRO,
> e depois confere contra a árvore — nunca ao contrário. O projeto é a fonte de
> verdade; este arquivo é o índice dela.

- mission_id: `DZ23-ENGINEERING-OS-20260911`
- objetivo: evoluir o repositório para o "DZ23 DEEPSEEK ENGINEERING OS" descrito
  no prompt mestre, com prova verificável em cada passo
- estado: `EXECUTING`
- branch: **`integ`** (nunca `main`)
- upstream: `deepseek-harness@6c705be1ce6774a000d061da41d1823b03a3d42c`, zero diff
- ponta: ver `git log -1`

## Onde está a verdade de cada coisa

| pergunta | arquivo |
| --- | --- |
| o que falta, por requisito, com prova e próximo passo | `docs/MASTER_REQUIREMENTS_LEDGER.md` |
| qual tarefa está pronta para começar | `docs/status/TASK_DAG.md` |
| quais números valem hoje | `docs/status/PROJECT_STATUS.md` |
| o que foi decidido e por quê | `docs/adr/`, lido por `pnpm gate:decision-record` |

## Placar objetivo (12/09/2026)

- portões estáticos: **18/18 EXIT=0**
- typecheck raiz: 0
- suíte raiz: **2.988 aprovados, 66 pulados** (185 arquivos)
- suíte da interface: **435 aprovados**
- e2e em navegador real: **93 aprovados, 0 reprovados, 5 pulados**, nos quatro
  tamanhos (mesa, tablet, celular, faixa estreita de 900px), com axe em modo
  claro e escuro
- livro mestre: **206 requisitos** — STABLE 63, BETA 103, NOT_PRESENT 33,
  NOT_EXECUTED 4, NOT_CONFIGURED 1, FAILED 2

## Como este laço anda

Uma tarefa `READY` por vez, e cada correção passa por **falsificação**: o
conserto é revertido e o teste correspondente TEM de reprovar. Sem isso, um
teste que passa pelo motivo errado ocupa o lugar de um que funcionaria.

Nesta sessão a falsificação pegou **nove** testes meus que passavam pelo motivo
errado, e duas revisões adversariais independentes derrubaram trabalho meu do
mesmo dia:

1. um duble de teste chaveado com mais cuidado que a produção escondia que uma
   organização apagava a missão de outra (OS-46);
2. a correção do cookie sombra (OS-45) não curava nada, porque remoção de cookie
   casa por caminho e quem planta escolhe o caminho (OS-47).

A lição que ficou escrita no código: **um duble mais cuidadoso que o produto não
testa o produto**, e **uma correção sem revisão de terceiro é uma hipótese**.

## O que depende do Prado, e não de mais trabalho

| assunto | decisão pedida |
| --- | --- |
| `ADR-034`, `ADR-038`, `ADR-039` | renumerar, ou manter os números compartilhados declarados (ADR-047) |
| domínio das prévias | servir prévia em domínio registrável DIFERENTE do Studio fecha a família inteira do cookie sombra; enquanto for o mesmo, o `__Host-` cobre o navegador que o aceita |
| `edgeRequired` sem `X-Forwarded-For` | exigir o cabeçalho (recusa alta e barulhenta) ou manter e documentar na instalação (OS-38) |
| C-05 | confirmação jurídica da Apache-2.0 e revisão de advogado do TRADEMARKS.md |
| S-08 | texto do requisito e desenho da varredura de início (ADR-044) |

## Bloqueios externos reais

`P-07` chave de LLM real · `S-04` e `D-10` rede para registro de pacote ·
`D-09` aparelho Android físico · `H-11` conversa longa com modelo real ·
`U-04` uma pessoa leiga de verdade.

Um bloqueio externo **não encerra a missão**: as tarefas independentes seguem.

## Próxima ação

Ler `docs/status/TASK_DAG.md` e pegar a tarefa `READY` de maior prioridade. Hoje
as candidatas são T-26 (as cinco memórias restantes), T-11 (registro de
habilidades), T-15 (inteligência de código), T-17 (pesquisa com procedência),
T-18 (QA visual) e T-28 (superfície da trilha).

## Instruções de retomada

1. `git log -1` e `git status` — a árvore deve estar limpa e em `integ`;
2. `node scripts/check-requirements-ledger.mjs` — o placar objetivo;
3. `npx vitest run` na raiz e `npx playwright test` em `apps/studio-web`;
4. só então escolher tarefa, e atualizar este arquivo ao terminar.

**Entrega:** o bundle vai para a pasta de downloads da máquina de quem opera e o Prado aplica com
`git pull <bundle> integ`. Nunca há push daqui.
