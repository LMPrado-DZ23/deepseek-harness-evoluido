# Os dois pontos que existiam sem quem os chamasse (08/09/2026)

**Branch:** `claude/integration-candidate-20260907`
**Harness:** `6c705be1ce6774a000d061da41d1823b03a3d42c` — **zero diff**

O M75-B deixou duas capacidades escritas, testadas e **inalcançáveis**:
`resolveUnknownRun` (a única saída do estado `UNKNOWN`) não tinha nem tela nem
ferramenta, e `shutdown(deadlineMs)` nunca era chamado por ninguém. Código que
passa nos testes e que a execução nunca alcança é uma promessa vazia.

## `UNKNOWN` agora tem saída, e quem decide é uma pessoa

Quando o Studio não consegue provar que um programa externo morreu, a execução
fica em `UNKNOWN` — deliberadamente, porque declarar morte sem prova seria
mentir. A saída existia no serviço; agora existe também na ponte:

- ferramenta `studio_agent_resolve_unknown`, classificada **T3** no catálogo
  fechado e no perfil (`tools=14`);
- exige um motivo escrito de 3 a 500 caracteres — o registro precisa dizer
  **quem** decidiu e **por quê**, já que nenhuma prova técnica sustentou a
  conclusão;
- passa pelo mesmo portão do M90-A: o modelo só consegue `APPROVAL_REQUIRED`, e
  quem transforma isso em encerramento é uma pessoa com chave de acesso;
- a **impressão digital cobre o motivo**: confirmar um encerramento e gravar
  outra justificativa são duas coisas diferentes, e a permissão de uma não
  serve para a outra;
- o resumo devolvido é relido pelo **mesmo caminho escopado**, então é o que
  ficou gravado, não o que o método achava que ia gravar.

## O encerramento ativo agora acontece

`ctx.effect(… 'studio-agents.shutdown')` foi registrado **depois** da abertura
dos domínios, então é descartado **antes** deles — o que o encerramento grava
ainda encontra o armazenamento aberto. O que sobreviver ao prazo **não é
declarado morto**: fica para a reconciliação do próximo início, e o log diz
quantas execuções ficaram.

## Provas

| # | Mutação | Resultado |
|---|---------|-----------|
| S1 | o encerramento ativo não é ligado ao ciclo de vida | 1 falha |
| S2 | encerra um `UNKNOWN` sem confirmação humana | 2 falham |
| S3 | a confirmação não cobre o motivo escrito | 1 falha |

O teste de composição do `agents` passou a **rodar os descartes na ordem
inversa do registro** e a exigir que `studio-agents.shutdown` aconteça antes de
`studio-agents.domainClose`. Antes ele descartava o disposer e não exercitava
nada disso.

## Portões

- `tsc --noEmit` **PASS** · `pnpm build` **PASS**
- Suíte completa com PostgreSQL real: **2182 passaram**, 3 falhas ambientais em
  `builder-supervisor` (uid 0; como usuário não privilegiado passam 103/103)
- Cobertura: **zero violações de limiar** (96,11% stmts / 93,58% branches)
- `ASSISTANT_TOOL_CATALOG=PASS tools=14` com as três mutações negativas
- `I18N_GATE=PASS catalogs=15` — o aviso de encerramento foi para o catálogo
- `DOMAIN_ROUTE_GATE=PASS domains=26` · `domain-scopes` PASS
- `PORTABILITY=PASS findings=0` · `UPSTREAM_PIN=PASS commit=6c705be1`
- **P37** `PASS · 471 arquivos · 19 manifests · 1 licença · 0 achados`

## O que isto ainda NÃO é

- A ferramenta existe; **uma tela dedicada para "esta execução está parada"**
  ainda não. Hoje o pedido aparece na mesma lista de confirmações pendentes.
- Sem merge, sem push, sem deploy, sem Docker.
