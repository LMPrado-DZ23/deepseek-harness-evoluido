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
| procedimental | como fazer algo NESTE projeto, aprendido do que funcionou | PARCIAL | `plugins/prompt-to-app/src/learning.ts` |

## O que `PARCIAL` quer dizer na memória de falha

`FailureMemory` vive em memória e morre com a execução. Ela resolve o defeito
para o qual foi escrita — o laço de três tentativas repetindo a mesma correção
—, e não resolve o de fora: se a tentativa de ontem falhou por um motivo, e a
pessoa pede uma mudança hoje, nada lembra.

## O que `PARCIAL` quer dizer na memória procedimental

Ela era a única das sete sem casa, e foi deliberadamente a última: uma memória
que conclui o que FUNCIONA é a que mais facilmente vira superstição — duas
coincidências viram regra, e a regra passa a ser seguida por um agente. O
pré-requisito nunca foi armazenamento; era VALIDAÇÃO.

A validação chegou na OS-68 (`learning.ts`, `T-20`), e é ela que está aqui, não
a memória inteira. Quatro portões decidem se uma observação vira regra:
repetição em ocasiões INDEPENDENTES, contraprova EXAMINADA (um padrão nunca
contestado fica candidato para sempre, por mais evidência a favor que tenha),
taxa de erro abaixo do teto, e validade — regra validada sobre dado velho volta
a ser candidata.

O que falta para deixar de ser `PARCIAL`: ninguém GRAVA observações ainda. O
motor sabe julgar e não tem o que julgar — o mesmo padrão da OS-54 e da OS-60,
e pela mesma razão, que é ter as condições antes do que elas governam.

## Por que este documento existe como portão

Um mapa que envelhece em silêncio é pior que nenhum mapa: ele autoriza alguém
a não procurar. `gate:memory-map` confere que toda citação aponta para arquivo
existente, que os sete tipos estão presentes, e que nenhum estado foi inventado
fora dos três permitidos.
