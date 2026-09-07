# Prova M91 — continuidade de conversa e compactação honesta

Estado declarado: **`CHAT_COMPACTION_BETA`**.
Autor: Claude (Opus 5) — 07/09/2026. Especificação vinculante:
`outputs/M91_CHAT_CONTINUITY_COMPACTION_SPEC_20260907.md`.

## O que foi construído, e o que deliberadamente NÃO foi

O Studio **não** compacta. Quem compacta é o Harness fixado em
`6c705be1ce6774a000d061da41d1823b03a3d42c`, com `@deepseek-ai/dsh-compaction`,
os marcadores duráveis `compaction/start`, `compaction/summary` e
`compaction/end`, o limiar automático do `compaction-basic` e o comando
`/compact`. O submódulo **não foi tocado**: `git diff --submodule=diff` vazio.

O que esta fatia acrescenta é uma **projeção**. Os três marcadores são eventos
`log-only` do journal — não são eventos de superfície e, até aqui, não existiam
para o Studio. `sanitizeAssistantEvent` passa a traduzi-los em um único evento
público `compaction.state`.

## O que atravessa para o navegador — e o que fica no servidor

`compaction/summary` carrega `summary`, `rawOutput`, `provider`, `model`,
`maxTokens`, `usage`, `shadowedRange`, `shadowedSeqs` e `shadowedTokenCount`.
Atravessam **apenas** `compaction_id`, o estado, e as contagens reais
(`items` = `shadowedSeqs.length`, `tokens` = `shadowedTokenCount`).

O `error` de `compaction/end` é uma string do upstream: pode carregar caminho
local ou detalhe de provedor. Só a sua **presença** atravessa; a tela mostra a
frase de catálogo.

O resumo em si nunca é copiado: ele chega pelo `user/message` de substituição
que o próprio contrato do Harness posiciona logo depois do `compaction/summary`,
e portanto já passa pela projeção normal de mensagens.

## A regra de honestidade do progresso

Os eventos upstream **não carregam** `completed_units`/`total_units` nem
qualquer fração. Portanto a faixa é **indeterminada**, o `aria-valuenow` está
ausente de propósito, e não existe porcentagem em lugar nenhum.

Isso é verificado por teste, não por intenção: o teste 10 reprova qualquer
`percent|progress|ratio|completed_units|total_units` no estado projetado, e o
teste 12 reprova qualquer `/\d+%/` no HTML renderizado da faixa.

`RECONCILING` não é um estado do servidor: é o que o cliente diz quando o
journal andou para além do `summary` sem um `end`. A resposta honesta ali é
"ainda organizando, nada foi perdido" — nunca "concluído".

## Os 12 testes obrigatórios da especificação

| # | Teste | Onde |
|---|---|---|
| 1 | start → summary → checkpoint → end termina no marcador com contagens verdadeiras | `compaction.spec.ts` |
| 2 | start → end(error) mostra falha e não perde mensagem | `compaction.spec.ts` |
| 3 | reconexão depois do start e antes do end restaura a faixa | `compaction.spec.ts` |
| 4 | queda depois do summary entra em `RECONCILING`, sem dizer que concluiu | `compaction.spec.ts` |
| 5 | eventos duplicados, atrasados e fora de ordem são idempotentes e monotônicos | `compaction.spec.ts` |
| 6 | mensagem enviada durante a compactação é preservada e aplicada uma única vez | `compaction.spec.ts` |
| 7 | texto digitado e não enviado sobrevive à compactação inteira | `compaction.spec.ts` |
| 8 | evento de outra conversa não aparece nem altera a faixa | `compaction.spec.ts` |
| 9 | `rawOutput`, erro interno e metadados sensíveis nunca chegam ao payload público | `assistant-conversation.spec.ts` + `compaction.spec.ts` |
| 10 | reprova qualquer porcentagem sem unidades reais de backend | `compaction.spec.ts` |
| 11 | `/compact` manual e automático usam a mesma máquina e o mesmo journal | `compaction.spec.ts` |
| 12 | acessibilidade: leitor de tela, `role`/`aria-live`, movimento reduzido | `Conversation.spec.tsx` |

`/compact` manual aparece em **Opções avançadas** como "Organizar conversa
agora" e é enviado pela mesma rota de mensagem — não existe segunda máquina,
segundo journal nem segundo algoritmo de resumo.

## Gates executados

Clone limpo, container Linux, Harness no pin, submódulo sem diff:

- `tsc --noEmit` raiz **PASS**; `tsc -b` do app **PASS**
- `pnpm build` **PASS**
- `apps/studio-web`: 16 arquivos, **87 testes PASS**
- suíte raiz: **2059 aprovados**, 60 pulados, 3 reprovados
- coverage: statements 96,10% · branches 93,53% · functions 96,63% ·
  lines 98,11% — **zero violação de limiar**
- `I18N_GATE=PASS`

As 3 reprovações são as mesmas guardas de permissão POSIX do
`builder-supervisor` que o uid 0 do container derrota; como usuário sem
privilégio esses três arquivos passam 103/103. Não tocam esta fatia.

## Por que ainda é BETA, e não pronto

Falta a prova que **nenhum teste pode dar**: uma conversa longa real, num
navegador real, ultrapassando o limiar real do Harness, compactando e
continuando a responder na mesma sessão, com reconexão real no meio.

`NOT_EXECUTED`: E2E em navegador com servidor de pé, Harness e identidade.
Mock visual não fecha este gate, e este documento não afirma que fechou.
