# M93 — A-08: o painel do trabalho em equipe

## O que se afirma

O trabalho em equipe do Studio deixou de existir só dentro da conversa. Há uma
tela — `/studio/progresso` — que mostra a árvore das etapas, o estado de cada
uma, os arquivos, a evidência real, os bloqueios, quem autorizou, e o botão que
para o trabalho.

## Provas

**Rota, no perfil REAL, por HTTP de verdade** — `node scripts/prove-assistant-session-runtime.mjs`:

```
"teamPanel": { "list": 200, "foreign": 404, "anonymous": 401 }
"status": "PASS"
```

- `list: 200` — a rota está montada no perfil que o produto usa, e não só no código.
- `foreign: 404` — uma equipe de outro inquilino responde NÃO ENCONTRADA. Um 403
  confirmaria a existência dela a quem não é dono.
- `anonymous: 401` — sem cookie de sessão a rota não conta nem quantas equipes existem.

**Servidor** — `plugins/studio-web/tests/team-panel.spec.ts`: 22 testes.
**Mutação** — 12 mutações no `team-panel.ts`, **12 mortas**:

| mutação | morta |
| --- | --- |
| escopo: org ignorado na lista | sim |
| escopo: dono ignorado no detalhe | sim |
| parada: usuário vem do corpo | sim |
| custo: vira zero | sim |
| evidência: fila vira medida zerada | sim |
| bloqueio: `UNKNOWN` deixa de bloquear | sim |
| DAG: dependências somem | sim |
| motivo lido depois da parada | sim |
| teto do motivo desligado | sim |
| UUID: qualquer texto vira equipe | sim |
| 405 autentica antes | sim |
| erro desconhecido vira 400 | sim |

**Tela** — `apps/studio-web/src/team/teamApi.spec.ts` (14) e `TeamPanel.spec.tsx` (18):
238 testes na aplicação inteira, todos passando.

## As decisões que o código toma, e por quê

**O custo é `NOT_MEASURED`, e nunca `0`.** O Studio não contabiliza consumo por
etapa — o requisito A-07 está FAILED e o `UsagePort.tokensFor` do plugin de
agentes nunca foi ligado. Um `0` na tela seria lido como "esta equipe não custou
nada", que é a mentira mais cara que este painel poderia contar. A tela mostra a
frase que diz que ninguém mediu, e o guarda de tipo do cliente **recusa o painel
inteiro** se o servidor não mandar esse campo: um servidor antigo faria a tela
desenhar sem a frase, e o silêncio seria lido como ausência de custo.

**Etapa que não rodou diz `NOT_EXECUTED`, não "0 arquivos".** Zero arquivos
mudados ao lado de uma etapa em fila lê-se como trabalho feito sem efeito.

**A árvore é ordenação topológica, e ciclo não esconde etapa.** Um plano com
ciclo ou com dependência apontando para etapa inexistente continua desenhando
todas as etapas: as remanescentes vão para o fim. Esconder uma etapa por causa
de um erro de plano é pior que mostrá-la fora de ordem — o trabalho continua
existindo.

**De quem a etapa depende está ESCRITO, não só recuado.** O recuo não existe
para quem usa leitor de tela.

**Quem para sai da sessão.** O corpo do pedido carrega só o motivo. Um campo
`approved_by` deixaria o navegador escolher a autoria da parada, que é a única
coisa que ele não pode escolher. O serviço recusa a parada de quem não autorizou
o trabalho, e essa recusa chega como 403 com o código junto, para a tela dizer
"só quem autorizou pode parar" em vez de "tente de novo".

**Nada de caminho absoluto.** `repository_path`, `worktree_path`,
`parent_session_id` e o texto do `prompt` não atravessam a projeção. Há teste de
vazamento na projeção do servidor **e** no HTML da tela.

## Limites declarados

- **Não há rota de INICIAR equipe.** Começar exige o `Agent` vivo da conversa,
  que não atravessa HTTP. Uma rota que fingisse iniciar seria pior que a
  ausência dela.
- **Custo continua `NOT_MEASURED`** enquanto A-07 estiver FAILED.
- **As confirmações pendentes continuam na tela do assistente.** Aqui aparece
  quem autorizou a equipe, não a fila de confirmações.
- **Não há e2e de navegador com equipe real.** A prova de runtime cobre a rota;
  o desenho da árvore com dados vivos é coberto por teste de componente, não por
  navegador.

## Achado colateral: o resumo do ledger mentia

Ao fechar A-08 a tabela de resumo do `MASTER_REQUIREMENTS_LEDGER.md` dizia
`NOT_PRESENT 55`, `BETA 41`, `FAILED 25` — enquanto as linhas reais diziam 35,
71 e 15. Nenhum portão comparava a tabela com as linhas, e ela ficou parada
enquanto o ledger andava. Um resumo errado é pior que resumo nenhum: é o número
que as pessoas citam. `scripts/check-requirements-ledger.mjs` passou a conferir
o resumo contra as linhas, por estado e por versão-alvo, e a reprovar também o
resumo APAGADO — senão apagar a tabela faria o portão aprovar por não ter nada
com que discordar.
