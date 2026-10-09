# T-35 — o alcance REAL do ADENDO DZ23-USO-CUSTOS-API

> Pedido do proprietário, 17/09/2026, item 3: *"conclua o alcance real de T-35 —
> informe quais critérios do ADENDO já passaram; demonstre o caminho chamada
> autorizada → registro durável → tarefa → Uso e custos; verifique eventos
> duplicados, tentativas distintas, uso desconhecido, precificação, isolamento,
> reservas, concorrência e recuperação. Reaproveite a autoridade existente; não
> crie outra contabilidade."*

Este documento **não** é a prova. A prova é
[`plugins/route-health/tests/alcance-do-adendo.spec.ts`](../../plugins/route-health/tests/alcance-do-adendo.spec.ts),
um caso por critério, contra o serviço de produção. O que está aqui é o índice
dela e as três respostas que um teste não sabe dar: o que **não existe**, o que
**não foi observado**, e o que essa medição **mudou no código**.

Três palavras, e elas não se misturam:

- **PASSOU** — há teste verde contra o código de produção.
- **NÃO OBSERVADO** — foi medido e o resultado não decide a pergunta. Não é
  aprovação.
- **AUSENTE** — não há código. Não ganha teste inventado.

---

## O quadro

| critério do ADENDO | veredito | onde está a prova |
| --- | --- | --- |
| uso desconhecido não vira zero | **PASSOU** (depois de um conserto — ver abaixo) | `alcance-do-adendo.spec.ts` |
| medido + não medido = PARCIAL | **PASSOU** | idem |
| precificação a partir dos tokens | **PASSOU** | idem |
| rota sem preço não inventa custo | **PASSOU** | idem |
| isolamento por inquilino | **PASSOU** | idem |
| teto: custo excedido | **PASSOU** | idem |
| teto: não precificadas excedidas | **PASSOU** | idem |
| teto ausente não vira bloqueio | **PASSOU** | idem |
| tentativas distintas contam distinto | **PASSOU** | idem |
| evento de troca de rota não duplica | **PASSOU** | idem |
| recuperação: o consumo sobrevive à instância | **PASSOU** | idem |
| concorrência dentro de um processo | **NÃO OBSERVADO** | idem |
| concorrência entre processos | **AUSENTE** | — |
| reserva de orçamento antes da chamada | **AUSENTE** | — |
| conciliação com o provedor | **AUSENTE** | — |
| alertas de consumo | **AUSENTE** | — |
| cota de assinatura | **AUSENTE** | — |
| custo INFORMADO pelo provedor | **AUSENTE** | — |

---

## O conserto que esta medição produziu

O critério central do adendo — *ausência de prova não vira prova* — **estava
meio implementado**, e a medição é que mostrou.

`unpriced_requests` contava uma coisa só: chamada a uma **rota sem preço**. A
outra ausência, a mais comum, não era contada: o provedor **não declarar uso
nenhum**. Nesse caso os tokens somavam 0, o custo somava 0, `unpriced` não subia
— e o registro ficava afirmando *"medido, custou zero"* sobre uma chamada de
custo inteiramente desconhecido.

O efeito prático: um provedor que nunca declara uso parecia de graça, e o teto
de dinheiro nunca disparava por ele. Isso é exatamente o defeito que o adendo
existe para impedir, dentro do código que foi escrito para impedi-lo.

Consertado em `StudioRouteHealthService.record`: as **duas** ausências contam
como não precificada. Duas sabotagens confirmam a guarda; uma terceira
sobreviveu porque era código morto — a mesma condição repetida no cálculo do
custo, onde os tokens já são zero — e foi **removida**, em vez de ganhar um
teste que fingisse cobri-la.

---

## O caminho completo, ponta a ponta

O pedido era demonstrar `chamada autorizada → registro durável → tarefa → Uso e
custos`. Ele existe inteiro, e cada elo tem dono:

1. **chamada autorizada** — `chooseRoute` aplica o perfil de privacidade e o
   teto antes de escolher rota; `local-only` nunca sai para rota externa, e a
   recusa é auditada.
2. **registro durável** — `record` grava requisições, erros, tokens, custo
   estimado e não precificadas no domínio `studio_route_health`, por
   `org_id`/`tenant_id`/rota. Sobrevive a uma instância nova do serviço
   (provado).
3. **tarefa** — `studio_runs` grava o consumo por tentativa, com o identificador
   da tentativa.
4. **Uso e custos** — o painel da tarefa (`apps/studio-web/src/tarefa/uso.ts`)
   soma **por identificador**, porque a tentativa corrente chega duas vezes no
   corpo, e preserva ausência como ausência em vez de escrever `US$ 0,0000`.

**Nenhuma contabilidade nova foi criada nesta verificação.** O adendo proíbe um
segundo gateway ou ledger, e nada aqui abriu um.

---

## O que NÃO foi observado, e por que isso não é aprovação

A gravação do consumo é **ler-modificar-escrever**, sem escrita condicionada e
sem fila. Eu esperava medir perda de escrita em chamadas concorrentes e **medi o
contrário**: as duas contaram.

A razão está no ambiente, não na segurança do código. O dublê de armazenamento
resolve de imediato, então cada gravação completa inteira antes de a outra
começar. O que o teste prova é estreito: *com armazenamento síncrono e em um
processo, duas chamadas concorrentes contam duas.*

O que ele não prova:

- armazenamento com espera real (PostgreSQL) pode intercalar as duas leituras;
- **dois processos** do Studio no mesmo escopo certamente podem.

A guarda que fecharia isso — escrita condicionada como a da parada de
emergência, ou uma fila por registro — **não existe** neste plugin, e um teste
não pode inventá-la. Um caso à parte confere essa ausência pela assinatura de
`putRoute`, que não recebe expectativa nenhuma: quando a fatia C acrescentar o
parâmetro, o teste quebra e pede para ser reescrito.

A direção do risco também vale escrita: a perda seria de **registro**, não de
dinheiro — nada é cobrado a mais. Mas ela faria o teto ver **menos** consumo do
que houve, que é a direção perigosa. É por isso que a fatia C existe.

---

## O que está AUSENTE, sem rodeio

Nada disto tem código em lugar nenhum do repositório, e por isso nada disto tem
linha na tela — inventá-las é o que o adendo proíbe:

- **reserva de orçamento antes da chamada.** `routeBudgetUsage` responde sobre o
  passado. Duas chamadas que cabem sozinhas, mas não cabem juntas, passam as
  duas.
- **conciliação** com o que o provedor cobrou de fato.
- **alertas** de consumo.
- **cota de assinatura** e **custo informado pelo provedor**.
- **demais provedores** (fatia D): o que está exercitado é a rota de preço
  configurado e a rota sem preço.

E o limite que atravessa tudo: **nenhuma medição aqui foi feita contra um
provedor real** — `EB-04` continua aberto. O que está provado é o comportamento
do produto diante de respostas com e sem uso declarado, não o que um provedor de
verdade devolve.
