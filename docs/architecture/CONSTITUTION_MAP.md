# Mapa da constituição

A constituição diz o que não se decide de novo. Este mapa diz **quem obriga cada
linha dela** — e, quando ninguém obriga, diz isso com todas as letras.

Ele existe porque uma constituição que ninguém confere é uma carta de intenções.
O `T-10` pede "Constitution Engine aplicado pelo planner e pelo builder"; a
resposta honesta, medida antes de escrever código, é que **metade das cláusulas
já tem quem as obrigue** — e o valor está em nomear a outra metade em vez de
construir um segundo motor em cima do primeiro.

Estados possíveis, e só estes três:

- `PORTÃO` — há um portão que reprova quem violar. A célula nomeia qual.
- `CÓDIGO` — há código de produto que recusa, e não um portão de repositório.
- `NÃO AUTOMATIZADO` — ninguém confere hoje. O motivo está escrito.

| cláusula | o que ela proíbe ou exige | estado | quem obriga |
| --- | --- | --- | --- |
| 1.3 | sem cobrança, paywall, checkout | NÃO AUTOMATIZADO | nenhum portão procura por Stripe, checkout ou tela de upgrade no produto |
| 2 | autoridade única por domínio | NÃO AUTOMATIZADO | a lista é arquitetural; não há como um portão saber que uma segunda autoridade nasceu |
| 3 | diff zero no Harness | PORTÃO | `gate:upstream-pin` |
| 4.2 | 9Router e OmniRoute nunca juntos | NÃO AUTOMATIZADO | depende do perfil montado em execução, e não da árvore |
| 4.4 | nenhum componente BSL no artefato | PORTÃO | `gate:no-caveman` |
| 4.9 | nenhum segredo em cliente, log ou pacote | PORTÃO | `gate:secrets` |
| 4.13 | nenhuma cópia de terceiro sem P37 | PORTÃO | `gate:p37`, `gate:vendored-references` |
| 5.1 | portão que passa com zero itens é falha | PORTÃO | `gate:constitution` (modo `--verdicts`) |
| 5.2 | guarda nova exige mutação que prove o teste falhar | NÃO AUTOMATIZADO | a falsificação é feita por quem escreve; nenhum portão sabe se ela aconteceu |
| 5.3 | mock, build verde ou 200 nunca viram "pronto" | PORTÃO | `gate:i18n` — recusa READY/DONE/PUBLISHED/DEPLOYED nos nomes de estado |
| 5.4 | estado ambiental vermelho vira NOT_EXECUTED com causa | CÓDIGO | `plugins/prompt-to-app/src/model.ts` |
| 5.7 | toda recusa explicada em português claro | PORTÃO | `gate:i18n`, `gate:vocabulary` |
| 6 | nunca apagar worktree, branch, histórico ou `lib/**` | PORTÃO | `gate:tracked-lib` |
| 7 | o ledger é a fonte única do que falta | PORTÃO | `gate:requirements-ledger` |

## O que `NÃO AUTOMATIZADO` custa

Cinco cláusulas não têm quem as obrigue, e elas não são as menos importantes —
a `5.2` é a regra que sustenta todo o resto deste repositório. O que se pode
dizer com honestidade é que **ela é seguida e não é conferida**: cada requisito
do livro mestre nomeia as falsificações que fez, e nenhuma máquina confere que
elas existiram.

Automatizá-la exigiria rodar cada sabotagem na integração contínua, o que é
trabalho de verdade e está registrado como tal. O que este mapa impede é o pior
desfecho: alguém ler a constituição e supor que ela se obriga sozinha.
