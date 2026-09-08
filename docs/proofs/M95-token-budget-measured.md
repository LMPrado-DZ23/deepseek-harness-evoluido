# M95 — A-07: o teto por tokens deixou de ser promessa

## O que se afirma

O consumo de tokens de uma execução do agente local é **medido de verdade**,
fica gravado na execução, e o painel do trabalho em equipe mostra o número — ou
diz, com todas as letras, quando ele não existe.

## Prova

`node scripts/prove-fase3-agents.mjs`:

```
"budgets": {
  "timeoutMs": 30000,
  "maxFiles": 1,
  "maxDiffBytes": 16384,
  "tokenLimitMeasurable": true,
  "tokensUsed": 26
}
```

Antes, esse campo era o literal `false` escrito no próprio arquivo da prova — a
prova imprimia a própria falha do requisito. Agora ele sai do **registro da
execução**: enquanto disser `false`, o `maxTokens` do orçamento não tem como
estourar e a promessa de orçamento por token é da boca para fora.

Os `26` tokens vieram da projeção `tokenUsage` do Harness, que soma o que o
**provedor relatou** por chamada — entrada, saída e tráfego de cache. Não é
estimativa nossa, e não é a pressão de contexto do momento: é o que foi
consumido.

Testes: `plugins/agents` 51, `plugins/studio-web/tests/team-panel.spec.ts` 30,
`apps/studio-web` 244. **9 mutações, 9 mortas:**

| mutação | morta |
| --- | --- |
| ausência de medida vira zero | sim |
| consumo medido não é gravado | sim |
| etapa sem medida vira zero | sim |
| soma pela metade vira total completo | sim |
| etapa em fila conta como "falta medir" | sim |
| equipe sem medida nenhuma vira zero medido | sim |
| custo de equipe malformado passa pelo guarda | sim |
| PARCIAL sem tamanho passa pelo guarda | sim |
| custo de etapa malformado passa pelo guarda | sim |

## As três decisões, e por quê

**`null` nunca é `0`.** Um provedor externo (`codex`, `claude-code`) roda em
outro processo e não publica consumo aqui. Se a ausência de medida virasse
zero, o teto por tokens deixaria de estourar *por falta de medição* em vez de
por estar dentro do combinado — e a tela afirmaria que uma execução não
consumiu nada.

**O campo é OPCIONAL e a versão do domínio não subiu.** `storageDomain.open()`
falha com `version-mismatch` numa instalação que já rodou, e não existe passo de
migração neste seam: subir a versão faria o Studio parar de abrir o domínio de
execuções **para sempre**. Uma execução gravada antes deste campo continua
legível e diz "não medido".

**PARCIAL é um estado próprio, e ele avisa.** Quando só parte das etapas de uma
equipe trouxe medida, o painel mostra a soma **e** diz, com `role="alert"`, que
o número é MENOR que o consumo real. Somar as medidas e apresentar o resultado
como total faria uma equipe com um agente externo parecer mais barata do que
foi. Uma etapa que ainda está na fila não entra na conta de "quantas faltam
medir": ela não tem o que medir, e contá-la deixaria o total permanentemente
incompleto.

## Limites declarados

- Provedores externos seguem `tokens_used: null`. O teto por tokens vale hoje
  para o agente local.
- Profundidade de delegação continua fixa em 1.
- Tentativas não são configuráveis por pedido.
