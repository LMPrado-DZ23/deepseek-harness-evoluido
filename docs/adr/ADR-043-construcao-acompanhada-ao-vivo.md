# ADR-043 — A construção passou a ser acompanhada ao vivo

- Estado: Aceita
- Data: 2026-09-09
- Autor: Claude (Opus 5), dentro da autonomia delegada por Prado ("quero atacar os dois, você decide a ordem")
- Requisitos correspondentes: `E-06`, `U-01`

## Contexto

O Prado disse duas coisas na mesma frase, e as duas eram sobre a mesma falha:

> "meus projetos e ver resultado está marcado como em breve, mas isso significa
> que o projeto não está pronto — e outra, a ideia desse projeto é ver a
> construção em tempo real como é feito na prévia do Lovable"

A primeira parte é sobre o que o produto **diz**. A segunda é sobre o que ele
**mostra**. Ambas descrevem um produto que se anuncia inacabado.

### O que a tela mostrava durante a criação

Uma frase. O registro de execução guardava a *etapa* — `build` ou `test` — e o
construtor roda **quatro passos** dentro dessas duas: `install`, `build`,
`test`, `e2e`. Durante os minutos mais longos do produto a pessoa via o mesmo
texto imóvel enquanto quatro coisas diferentes aconteciam.

O problema não é estético. Numa tela onde nada muda, **"trabalhando" e
"travado" têm exatamente a mesma aparência** — e quem não programa não tem como
distinguir os dois. A única saída é esperar mais, ou recarregar e perder o fio.

O relato do que aconteceu (`E-06`, `RunReport`) já existia e é bom, mas é
**post-mortem**: só existe depois que a tentativa termina. Ele responde "o que
aconteceu?" e não "está andando?".

## Decisão

### 1. O registro passou a guardar os passos, enquanto eles acontecem

`StudioRun.steps` — opcional, e a versão do domínio **não sobe**, pelo mesmo
motivo de `template_integrity` e `attestations`: subir faria `open()` falhar com
`version-mismatch` para sempre numa instalação que já rodou, e não existe passo
de migração neste seam. Ausente quer dizer "execução anterior a este registro",
nunca "não teve passos".

O pipeline grava cada passo **duas vezes**: como `RUNNING`, *antes* de começar,
e de novo quando termina. Gravar só no fim passaria por qualquer teste que
olhasse o registro final — e não mostraria nada a ninguém enquanto a espera
acontece, que é o defeito inteiro. É por isso que o teste afirma o **meio**:
existe um registro em que `install` já terminou e `build` está em andamento.

Um passo que **explode** também é fechado, como `FAILED`. Deixá-lo eternamente
`RUNNING` faria a tela girar para sempre num passo que já acabou — a aparência
exata de um travamento, que é o que estamos consertando.

### 2. `PASSED`, e não `DONE`

A primeira versão do campo dizia `DONE`. O `gate:i18n` reprovou: ele recusa
`READY`, `DONE`, `PUBLISHED` e `DEPLOYED` nesta máquina de estados, porque essas
palavras afirmam mais do que qualquer registro pode sustentar. O que o sistema
sabe é que o passo rodou e saiu com código zero — `PASSED`, o mesmo vocabulário
que os estados de execução já usam. **O portão estava certo e eu estava errado.**

### 3. A tela

Uma lista ordenada (`<ol>`) com os quatro passos, frase em pt-BR, o tempo do que
já terminou, e o estado **nunca só por cor**: a palavra fica ao lado do ponto,
porque verde-e-vermelho desaparece para quem não distingue os dois e some de
novo no modo escuro.

As frases vêm de uma tabela **exaustiva** sobre a união (`Record<BuildStepName,
string>`): um passo novo no construtor não compila até alguém escrever a frase
dele. A alternativa — buscar num objeto solto — deixaria o passo novo aparecer
em branco na tela de quem não programa.

Um passo que o servidor manda e o cliente não conhece é **descartado** em vez de
quebrar a lista: um servidor mais novo que a interface não pode apagar a tela de
quem está esperando.

**Ausência tem dois significados, e a diferença importa.** Enquanto a execução
corre, um passo sem registro "ainda vai acontecer"; depois que ela termina, "não
chegou a acontecer". Dizer "ainda vai" sobre um passo que nunca vai é a
definição de deixar alguém esperando — e é a mesma distinção que o `RunReport`
já fazia, agora aplicada ao tempo real.

**Sem cronômetro correndo** para o passo em andamento. Ele teria de ser
redesenhado a cada segundo e congelaria no primeiro engasgo de rede — e um
número parado mente com mais convicção do que número nenhum.

### 4. "Ver resultado" morreu, e isso é a correção

Era um item de navegação sem destino, marcado "em breve". A tela prometida
**nunca ia existir separada**: o resultado é o pé da tela inicial — verificação,
relato, pontos de retorno e a prévia embutida — e "Início" já leva ao projeto
aberto, que fica guardado no endereço. Um item que duplica outro dá uma segunda
porta para a mesma sala.

Saiu junto o rodapé com a engrenagem desabilitada de "Configurações". Um botão
morto não é uma promessa simpática: é a interface admitindo que está inacabada,
toda vez que a pessoa abre o menu.

Com os dois últimos itens sem destino fora, `StudioNavItem.href` deixou de ser
`string | null` e virou `string`. **A etiqueta não pode voltar por descuido: um
item novo não compila sem destino.**

## Consequências

- 8 `putRun` por tentativa em vez de 4. É escrita em chave-valor de um registro
  que já era escrito; o custo é real e pequeno, e compra o único sinal que
  separa "andando" de "parado".
- O teste de `mobile-nav` teve a afirmação **invertida**: exigia `"em breve"`
  visível — era assim que se provava que um item sem tela aparecia como
  indisponível — e agora exige contagem zero, em quatro larguras de tela.
- Ainda **não** é o Lovable. O Lovable mostra o app se redesenhando a cada
  arquivo, com servidor de desenvolvimento e recarga quente. Aqui a prévia
  continua aparecendo **depois** que o artefato existe, e o que ficou ao vivo é
  o *progresso da construção*, não o *resultado se formando*. A diferença está
  registrada em `docs/plans/` e não está sendo escondida atrás desta entrega.

## Dois defeitos que só apareceram por olhar

Nenhum dos dois estava no plano, e os dois são do tipo que passa despercebido
para sempre se ninguém abrir a tela.

**A palavra repetida.** A primeira captura mostrou "Montando o aplicativo" no
alto, como frase da etapa, e "Montando o aplicativo" em negrito na lista logo
abaixo — as mesmas três palavras, duas vezes, com quinze pixels entre elas.
Texto repetido faz quem lê parar e procurar a diferença que não existe. A linha
do tempo diz tudo o que a frase dizia e mais, então a frase saiu quando há
passos. Quando não há — execução antiga, ou servidor que ainda não atualizou —
ela continua sendo a única coisa que separa "trabalhando" de "travado", e o
teste que antes provava a frase agora prova exatamente esse caso, apagando
`steps` da resposta de propósito.

**O degrau de título.** O `<h3>` da lista vinha logo depois do `<h1>` da tela,
pulando o `<h2>`: quem navega por títulos com leitor de tela perde o degrau. O
axe apanhou — mas **só porque este pedaço ganhou varredura própria**. A
varredura do fluxo principal não passa por aqui, porque a linha do tempo só
existe com uma execução congelada no meio, e nenhum outro teste congela uma. Sem
essa chamada, a única tela que a pessoa encara por minutos seria também a única
que o axe nunca veria. A varredura roda em claro **e** escuro, que é onde cor
sozinha desaparece de vez.

## Uma armadilha de ferramenta, registrada para o próximo

O roteiro que captura as imagens do README falhou em silêncio: o congelamento da
resposta nunca acontecia, e ele esperava trinta segundos por uma tela que não ia
aparecer. `page.on('request')` avisava das chamadas; `page.route` não
interceptava nenhuma.

Causa: o Studio é uma PWA. Depois que o *service worker* assume o controle da
aba, as chamadas passam por ele, e `page.route` deixa de ver o que acontece. A
correção é uma linha — `serviceWorkers: 'block'` no contexto da captura — mas
achar o motivo levou seis execuções, e por isso está escrito aqui e no próprio
roteiro. A cópia salva tem prova própria em `tests/pwa.spec.ts`; na captura ela
só atrapalha.

## Falsificação

- Sabotando o pipeline para gravar os passos só no fim: os dois testes novos de
  pipeline reprovam.
- Sabotando a distinção "ainda vai" / "não chegou a ser": o teste de unidade
  reprova.
- Um portão que passa com zero itens é uma falha; estes reprovam pelo motivo
  certo.
