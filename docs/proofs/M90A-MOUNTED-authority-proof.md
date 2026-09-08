# M90-A montado — o portão T3 real (08/09/2026)

**Branch:** `claude/integration-candidate-20260907`
**Commit:** `b6d2ba2c4e9e899d930e3ff56e53501374f1abdc`
**Base:** `61ba89e9b1c2145f91089ff0fe3d27084151b41a`
**Harness:** `6c705be1ce6774a000d061da41d1823b03a3d42c` — zero diff (UPSTREAM_PIN=PASS)

## O que estava errado

O portão T2/T3 que de fato rodava era literal:

```ts
approval: { approved: true, tier, approvedBy: principal.userId }
```

fabricado em `plugins/assistant-bridge/src/service.ts`. O modelo pedia
`studio_agent_start_sensitive` e o próprio servidor se autoconcedia o nível T3.
O `plugins/action-approval` do M90-A existia, era testado, e **não estava
montado em perfil nenhum** — não protegia nada em execução.

Isto era **pré-existente a `f1677b4`**, não uma regressão da candidata. Era o
maior achado aberto das três auditorias independentes.

## O que passou a valer

1. **`plugins/assistant-bridge/src/approval.ts`** — portão por composição.
   O descritor é derivado no servidor: ação, sujeito e uma impressão digital
   canônica do que está sendo pedido (provedor, instrução, caminhos). O modelo
   nunca escolhe nível, ação, sujeito nem impressão digital, e a única coisa que
   ele consegue obter é `APPROVAL_REQUIRED` com o `approval_id` pendente.
2. **Uma confirmação vale por uma execução.** O pedido é idempotente enquanto
   está aberto — repetir a chamada cai no mesmo `approval_id`, que é o que a
   pessoa confirma. Depois de consumido ou vencido, a chamada seguinte abre um
   pedido **novo e utilizável**. Depois de recusado, nada reabre.
3. **`plugins/action-approval/src/plugin.ts`** — plugin montável. A persistência
   é durável sobre o seam real de domínio, que só oferece `put(chave, valor)`
   **sem escrita condicional**; por isso o estado esperado é conferido ali, sob
   o mutex do serviço, e divergência vira conflito — nunca sobrescrita de uma
   confirmação alheia.
4. **Identidade forte real.** T3 exige chave de acesso recente **na mesma
   sessão**, lido do Identity de verdade pelo novo
   `strongIdentityForSession(sessionId)`. Sessão inexistente, revogada ou
   vencida não é identidade forte. Recusar por identidade fraca **não queima**
   o pedido: a pessoa confirma de novo depois da passkey.
5. **Rota montada.** `/studio/approvals` entrou na superfície autenticada que já
   existe (cookie de sessão + CSRF + confiança de host e origem). O cliente só
   confirma, nega ou lê; **não existe rota de criação**. Sem a autoridade
   montada a rota responde `503 NOT_CONFIGURED` em vez de sumir num 404 confuso.
6. **Sem autoridade montada, T3 recusa.** `NOT_CONFIGURED`. O bridge nunca
   volta a se autoconceder.

## Provas — um guarda que não pode falhar não é guarda

Nove mutações, cada uma derrubando os testes que a cobrem:

| # | Mutação | Resultado |
|---|---------|-----------|
| M1 | não recusa enquanto o pedido está `PENDING` | 7 testes falham |
| M2 | `request_id` e `claim_id` fixos entre tentativas | 1 falha |
| M3 | negativa passa a rotacionar (contornável) | 1 falha |
| M4 | impressão digital cega ao que foi pedido | 1 falha |
| M5 | sem autoridade, autoconcede | 1 falha |
| M6 | rota sem o `NOT_CONFIGURED` | 1 falha |
| M7 | escrita durável sem conferir o estado esperado | 1 falha |
| M8 | identidade forte sempre verdadeira | 2 falham |
| M9 | sessão revogada vale como identidade forte | 1 falha |

M2 **sobreviveu na primeira rodada**: com identificadores fixos o resultado
continuava sendo recusa (falha fechada), mas por engano — o pedido virava um
beco sem saída. O teste foi endurecido para exigir que a próxima tentativa abra
um pedido novo **e utilizável**, e a mutação passou a falhar.

## Portões executados

- `tsc --noEmit` **PASS** · `pnpm build` **PASS**
- Suíte completa com **PostgreSQL 16.13 real**: **2159 passaram**, 4 falhas
  apenas em `builder-supervisor`.
  Essas 4 são **ambientais**: como `uid 0` os guardas de `chmod` não conseguem
  falhar. Rodando como usuário não privilegiado, os três arquivos passam
  **103/103** — e aí falham outros dez, por posse do checkout que é do root.
  Nenhum defeito de produto; o contêiner não satisfaz as duas condições ao mesmo
  tempo. Estado: `NOT_EXECUTED_CLEANLY (ambiental)`.
- Cobertura: **zero violações de limiar** (96,12% stmts / 93,60% branches).
  `approval.ts` entrou no grupo de 100% do `assistant-bridge`.
- `I18N_GATE=PASS catalogs=15 keys=290` (literais herdados **não** cresceram)
- `DOMAIN_ROUTE_GATE=PASS domains=26` · `domain-scopes` **PASS**
- `ASSISTANT_TOOL_CATALOG=PASS tools=13` (com as três mutações negativas)
- `PORTABILITY=PASS findings=0` · `UPSTREAM_PIN=PASS`
- **P37** `PASS · 469 arquivos · 19 manifests · 1 licença · 0 achados`
  (self-test PASS: o gate reprova artefato vazio, dependência proibida e
  assinatura de código proibido — um gate que passa com zero itens seria falha)

## O que isto ainda NÃO é

- **Não há tela.** A rota existe e é autenticada; a interface que mostra
  "confirme esta operação" ainda é `NOT_IMPLEMENTED`. Hoje a confirmação é um
  `POST` em `/studio/approvals/<id>/confirm`.
- **Não houve merge, push, deploy nem Docker.**
- `pnpm-lock.release.yaml` continua defasado: a imagem de release não contém
  esta candidata.
