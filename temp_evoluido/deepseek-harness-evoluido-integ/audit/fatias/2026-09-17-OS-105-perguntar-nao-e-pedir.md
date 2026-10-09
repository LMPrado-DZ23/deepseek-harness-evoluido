# Fatia — OS-105: perguntar deixou de custar uma tentativa

## 1. O defeito, na frase de quem o apontou

> "Não transforme automaticamente toda mensagem em novo critério de aceite.
> Preserve o texto e a ordem do histórico."

Confirmado lendo `destinoDoEnvio`: depois de um resultado, **todo** envio caía
em `ajustar`, e `ajustar` grava o texto como critério de aceite permanente na
especificação. "Por que falhou?" virava um critério de aceite chamado "por que
falhou?", que a tentativa seguinte tentaria satisfazer — e a pessoa pagava uma
tentativa por ter perguntado.

A OS-103 tinha tirado o silêncio: o compositor passou a AVISAR antes. Avisar
não é consertar.

## 2. A escolha é da pessoa, e não do classificador

A tentação óbvia era adivinhar — "isso parece uma pergunta". Seria a mesma
automação que produziu o defeito, só que mais difícil de ver quando errasse, e
o erro seria irreversível: um critério de aceite gravado não sai da
especificação.

O compositor pede a escolha, em dois botões de rádio de verdade:

- **Perguntar** — não muda nada;
- o gesto que ESTE momento espera, com o nome dele: *Responder*, *Pedir
  mudança no plano* ou *Pedir alteração*. Rótulo fixo "Enviar" devolveria o
  silêncio.

**O padrão é "Perguntar" exatamente onde o defeito morava.** Quem não reparar na
escolha não grava nada; o contrário custaria um critério permanente. Onde a
tarefa espera um gesto — pergunta de admissão aberta, plano proposto —, o padrão
é esse gesto: ali não há defeito a evitar.

E perguntar funciona **durante a criação**. Uma pergunta não escreve na
especificação, não propõe plano e não dispara tentativa: não tem com o que
concorrer. Segurar o envio ali era silêncio na hora em que a pessoa mais quer
saber o que está acontecendo.

## 3. Onde a pergunta mora — e o que NÃO foi criado

Na mesma conversa que já existe, `studio_intake_turns`, com um `question_id`
próprio. Sem armazenamento novo, sem journal paralelo, sem segunda conversa: a
decisão do titular proíbe os três, e o histórico precisa sair em ordem única de
um lugar só.

**A versão do domínio NÃO sobe.** Acrescentar um valor ao conjunto de
`question_id` não invalida registro nenhum já gravado; subir a versão faria
`open()` recusar toda instalação que já rodou, sem passo de migração neste seam.

Na conversa, **a autoria vira**: no questionário quem pergunta é o estúdio e
quem responde é a pessoa; numa pergunta dela, é o contrário. Atribuir a fala de
alguém a outro é a mesma mentira que este módulo recusa em qualquer outra linha.

## 4. A resposta é feita só de fato registrado

Estado da tarefa, tentativas feitas, em que etapa a última parou, critérios
combinados, provas guardadas e custo estimado. Nada mais.

**Custo ausente vira "não registrado", e nunca zero** — um custo desconhecido
mostrado como `US$ 0,00` é a mentira mais barata que um painel de consumo
consegue contar, e o adendo de uso e custos do titular a proíbe por escrito.

A última linha da resposta diz, em voz alta, que ela não passa por modelo
nenhum e não interpreta a pergunta. **Isto não é um assistente**, e enquanto
`EB-04` estiver aberto nenhum modelo real responde aqui.

## 5. O achado do caminho — uma sabotagem SOBREVIVEU

`conversationFor` escolhia as respostas do questionário por **lista negada**
(`question_id !== 'sensitive-confirmation'`), dentro da montagem do corpo da
rota. Com a pergunta da pessoa na mesma conversa, a lista negada passaria a
injetar o turno dela em `IntakeConversation.answers` — que é lido para escolher
a próxima pergunta, para detectar dado sensível **e para montar a especificação
do aplicativo**.

Troquei por lista permitida e escrevi o teste. **A sabotagem que restaurava a
lista negada sobreviveu**: nenhum teste olhava para lá, porque a decisão morava
num `return` de rota — a lição que esta casa já pagou mais de dez vezes.

Virou `respostasDoQuestionario`, exportada, com quatro testes. Um deles é
exaustivo sobre o conjunto de `question_id` do domínio: um valor novo não entra
no questionário sem alguém decidir. Depois disso, a sabotagem é pega.

## 6. A quarta causa da CI — descoberta quando a terceira saiu

Com o teste de cookie corrigido (OS-104), a CI passou da suíte de navegador e
reprovou na de PostgreSQL:

```
{"status":"failed","error":"Credencial não secreta 'DZ23_OPERATOR_STATE_DIR' não configurada."}
```

Cinco testes que disparam a CLI de importação como processo filho **herdavam a
variável do shell de quem roda**. `docs/OPERACAO.md` manda exportá-la; a CI não
exporta. É a mesma classe do navegador da OS-104: o resultado do teste dependia
da máquina.

O teste passou a dar a si mesmo um diretório temporário. A guarda que EXIGE a
variável continua com teste próprio em `apps/studio-runtime/operator.spec.mjs` —
não foi afrouxada; deixou de ser exercitada por acidente.

Reproduzido aqui com `env -u DZ23_OPERATOR_STATE_DIR`: 5 reprovações antes, 254
testes passando depois, e `POSTGRES_GATE=PASS`.

## 7. Falsificação

| sabotagem | resultado |
| --- | --- |
| lista permitida volta a ser lista negada | **SOBREVIVEU** na montagem da rota → extraída para função exportada, 4 testes, **agora é pega** |
| `custoEstimadoUsd ?? 0` em vez de `?? null` | **PEGA** |
| remover a conferência de tamanho da pergunta | **PEGA**, em 3 testes |

## 8. A consolidação V7, registrada UMA vez

`SHA-256` do MASTER conferido nesta máquina e `package_check=PASS` com 102
arquivos. A correspondência está em `docs/inventory/master-v7.json` e o texto em
`docs/status/CONSOLIDACAO_V7.md`.

**33 dos 36 contratos D7 estão `A_REVALIDAR_PELO_EXECUTOR`**, que quer dizer
NÃO CONFERIDO — resposta diferente de "ausente" e de "pronto". As 36 jornadas E7
também. Três têm resposta com prova: `D7-001` (continuidade), `D7-003`
(PARCIAL, com onze divergências nomeadas) e `D7-004` (esta fatia).

Somar 36 contratos, 114 requisitos e 148 cenários como percentual de conclusão
produz número falso, e o próprio pacote proíbe.

## 9. Provas

| prova | resultado |
| --- | --- |
| `pergunta.spec.ts` (módulo puro + contrato entre servidor e tela) | 17 |
| `pergunta-service.spec.ts` | 10 |
| `http.spec.ts` | 36, com 4 novos |
| `compositor.spec.ts` | 18, com 7 novos |
| `transcricao.spec.ts` e `TaskScreen.spec.tsx` | 3 e 3 novos |
| suíte `studio-web` | 621 |
| PostgreSQL 16 real, **sem a variável do shell** | 254, `POSTGRES_GATE=PASS` |
| e2e `mesa`, Chromium da CI | 52 passaram / 3 pulados |

**Limitações declaradas:** a resposta à pergunta não passa por modelo real
(`EB-04`); a CI verde desta entrega só existe depois do push; o aceite visual é
do titular e não está declarado.
