# O beco sem saída do `approval.requested`, fechado por composição (08/09/2026)

**Branch:** `claude/integration-candidate-20260907`
**Harness:** `6c705be1ce6774a000d061da41d1823b03a3d42c` — **zero diff**

## O beco

A auditoria C apontou: o Studio publica `approval.requested` na conversa e não
existe forma de responder. Fui ler o seam:

`third_party/deepseek-harness/packages/interaction/user-approval/src/index.ts`

```ts
async request(req) {
  ...
  session.append('approval/asked', { id, toolName, ... })
  const outcome = await this.decide(req, session)   // <- aqui
  session.append('approval/decided', { id, outcome })
}

private async decide(req, session) {
  ...
  const answer = Promise.resolve().then(() => this.ctx.waterfall(
    scopeTarget(req.agent, req.agent), 'approval/request', req,
    () => Promise.resolve('unavailable'),          // <- fecho padrão
  ))
}
```

**Não existe API externa para responder uma aprovação.** A decisão sai
exclusivamente de respondedores compostos **no mesmo processo**, pelo waterfall
`approval/request`. Sem nenhum respondedor, toda pergunta cai no `'unavailable'`
fechado e a pessoa nunca vê nada.

Conclusão: o beco **não** exige mexer no Harness. Exige compor um respondedor —
que é exatamente o papel de Service Provider do seam.

## O que passou a existir

`plugins/action-approval/src/answerer.ts` liga a pergunta do Harness à
autoridade de confirmação do Studio:

1. A identidade sai da **linhagem durável do agente** (`principalForAgent`),
   nunca do que o modelo diz.
2. O descritor é derivado no servidor: `harness.tool.<ferramenta>`, o sujeito é
   a chamada sendo decidida e a impressão digital cobre ferramenta, chamada
   **e o motivo dado**. Trocar o motivo muda a impressão.
3. Cada pergunta abre o **seu** pedido (`harness-<uuid>`): o Harness não fornece
   identificador, e uma confirmação nunca vale para a pergunta seguinte.
4. O respondedor espera a decisão de uma pessoa real, relendo o pedido até o
   prazo. `AVAILABLE` consumido → `'allowed-once'`. Recusa explícita →
   `'rejected'`. Retirada da pergunta → `'cancelled'`. **Tudo o mais**
   (prazo esgotado, falha de armazenamento, pedido já usado por outra
   reivindicação, estado inesperado) → `'unavailable'`, fechado.
5. Sem identidade do Studio a pergunta é **delegada** (`next()`), preservando a
   composição — o seam fecha sozinho quando ninguém responde.

Montado no perfil `studio` com `answerHarnessApprovals: true` e
`harnessTier: T3`: um pedido do Harness é sempre escalada de permissão (caixa,
rede, arquivo fora do escopo), então exige chave de acesso recente na mesma
sessão.

## Provas — cinco mutações

| # | Mutação | Resultado |
|---|---------|-----------|
| N1 | pedido `PENDING` vira permissão | 6 testes falham |
| N2 | falha ao PERGUNTAR vira permissão | 1 falha |
| N3 | sem prazo máximo | a suíte **não termina** (laço infinito) |
| N4 | sem identidade do Studio, concede | 1 falha |
| N5 | identificador de pergunta fixo | 1 falha |

N5 sobreviveu à primeira rodada. Com identificador fixo, **duas perguntas
idênticas** (mesma ferramenta, mesma chamada, mesmo motivo) reusariam a mesma
confirmação e as duas passariam. Foi adicionada uma prova de concorrência: duas
perguntas rigorosamente iguais abrem **dois** pedidos, uma confirmação autoriza
**exatamente uma**, e a outra fecha em `'unavailable'`. A mutação passou a falhar.

## Portões

- `tsc --noEmit` **PASS** (sem nenhum `as never`) · `pnpm build` **PASS**
- Suíte completa com PostgreSQL real: **2175 passaram**, 3 falhas ambientais em
  `builder-supervisor` (uid 0 derrota os guardas de `chmod`; como usuário não
  privilegiado esses arquivos passam 103/103)
- Cobertura: **zero violações de limiar** (96,10% stmts / 93,56% branches)
- `I18N_GATE=PASS` · `DOMAIN_ROUTE_GATE=PASS domains=26` · `domain-scopes` PASS
- `ASSISTANT_TOOL_CATALOG=PASS` · `PORTABILITY=PASS findings=0`
- `UPSTREAM_PIN=PASS commit=6c705be1` — **o Harness não foi tocado**
- **P37** `PASS · 471 arquivos · 19 manifests · 1 licença · 0 achados`

## O que isto ainda NÃO é

- **Não há tela de confirmação.** O mecanismo é real e ponta a ponta, mas hoje a
  pessoa confirma por `POST /studio/approvals/<id>/confirm`. A interface é
  `NOT_IMPLEMENTED`.
- Enquanto a pergunta está aberta, o turno do Harness fica esperando. O prazo
  padrão é o mesmo do pedido (3 minutos), e esgotá-lo **fecha**, nunca abre.
- Sem merge, sem push, sem deploy, sem Docker.
