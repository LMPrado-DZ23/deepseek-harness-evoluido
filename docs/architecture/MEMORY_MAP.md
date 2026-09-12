# Mapa das memórias

O `T-26` pede "as outras seis memórias". Ao ir construí-las, a resposta honesta
apareceu antes da primeira linha de código: **quatro das sete já existem, com
outro nome.**

Construí-las de novo criaria uma segunda verdade para cada uma — dois lugares
guardando o que aconteceu, dois guardando o que o aplicativo é — e a segunda
verdade diverge no primeiro conserto de um dos lados. Este documento é o que
impede isso, e o portão `gate:memory-map` confere que cada citação aponta para
um arquivo que existe.

A regra de leitura: `EXISTE` significa que há código gravando e lendo aquilo
hoje. `PARCIAL` significa que existe e não atravessa a fronteira declarada.
`AUSENTE` significa que não existe, e o que falta está escrito.

| memória | o que ela guarda | estado | onde mora |
| --- | --- | --- | --- |
| decisão | por que uma escolha foi feita, e qual venceu | EXISTE | `scripts/decision-record.mjs`, `docs/adr/` |
| episódica | o que aconteceu em cada tentativa, e quando | EXISTE | `plugins/prompt-to-app/src/model.ts` (`studioRunsDomainSpec`, `studioEvidenceSchema`) |
| semântica | o que o aplicativo É: problema, público, entidades, e o código que existe | EXISTE | `plugins/prompt-to-app/src/appspec.ts`, `plugins/prompt-to-app/src/code-intelligence.ts` |
| avaliação | o que "pronto" significa aqui, e se foi atingido | EXISTE | `plugins/prompt-to-app/src/acceptance.ts`, `plugins/prompt-to-app/src/model.ts` (`acceptance_criteria`) |
| trabalho | o que está em jogo AGORA, com teto e procedência | EXISTE | `plugins/prompt-to-app/src/context.ts` |
| falha | o que já deu errado, para não repetir a mesma estratégia | PARCIAL | `plugins/prompt-to-app/src/failure-memory.ts` |
| procedimental | como fazer algo NESTE projeto, aprendido do que funcionou | EXISTE | `plugins/prompt-to-app/src/learning.ts` |

## O que `PARCIAL` quer dizer na memória de falha

`FailureMemory` vive em memória e morre com a execução. Ela resolve o defeito
para o qual foi escrita — o laço de três tentativas repetindo a mesma correção
—, e não resolve o de fora: se a tentativa de ontem falhou por um motivo, e a
pessoa pede uma mudança hoje, nada lembra.

## A memória procedimental, e por que ela foi a última

Ela era a única das sete sem casa, e a demora foi deliberada: uma memória que
conclui o que FUNCIONA é a que mais facilmente vira superstição — duas
coincidências viram regra, e a regra passa a ser seguida por um agente. O
pré-requisito nunca foi armazenamento; era VALIDAÇÃO.

Quatro portões decidem se uma observação vira regra (`T-20`): repetição em
ocasiões INDEPENDENTES, contraprova EXAMINADA (um padrão nunca contestado fica
candidato para sempre, por mais evidência a favor que tenha), taxa de erro
abaixo do teto, e validade — regra validada sobre dado velho volta a ser
candidata.

As três peças, e a ordem em que chegaram:

| peça | onde | o que ela resolveu |
| --- | --- | --- |
| julgar | `deriveRules`, `applicableRules` | os quatro portões entre uma coincidência e uma regra |
| o que julgar | `observationsFrom` | as observações são DERIVADAS de `studio_runs`, com a ocasião sendo a OPERAÇÃO e não a tentativa |
| a quem dizer | `recoveryNoteFor`, chamada pelo pipeline | quem acabou de ver uma criação falhar lê se aquela falha já foi superada antes, com os dois números junto |

**As observações não têm tabela própria, e isso é escolha.** Elas são derivadas
do registro de execuções, que já é a memória episódica: uma segunda tabela
dizendo a mesma coisa seria a segunda verdade que este mapa inteiro existe para
evitar — e ela divergiria no primeiro conserto de uma das duas.

**Limitação declarada:** uma regra validada informa uma PESSOA, e não entra em
prompt de agente nenhum. Essa foi a escolha da OS-79: deixar a estatística
DECIDIR negaria a alguém a tentativa que talvez funcionasse por causa do que
aconteceu em outro projeto — e quem já decide quando parar é a convergência,
por evidência DESTA execução.

## Por que este documento existe como portão

Um mapa que envelhece em silêncio é pior que nenhum mapa: ele autoriza alguém
a não procurar. `gate:memory-map` confere que toda citação aponta para arquivo
existente, que os sete tipos estão presentes, e que nenhum estado foi inventado
fora dos três permitidos.
