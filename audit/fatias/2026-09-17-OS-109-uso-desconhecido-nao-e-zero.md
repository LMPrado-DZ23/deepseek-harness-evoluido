# Fatia — OS-109: uso desconhecido não é zero (ADENDO, fatia B parcial)

## 1. O que já existia, medido antes de construir

O adendo `DZ23-USO-CUSTOS-API` estava registrado e não implementado. Antes de
escrever um contador novo, medi o que já existe — porque "a resposta honesta
já foi, várias vezes, que o motor existia com outro nome":

| capacidade | onde já mora |
| --- | --- |
| consumo por chamada (tokens, custo estimado) | `plugins/route-health`, por `(org, tenant, rota)` |
| requisições SEM preço configurado | `route-health`, campo `unpriced_requests` — já existe e já impede "não sei o preço" virar "custou zero" |
| teto em dinheiro com veredito | `route-health`, `WITHIN` / `COST_EXCEEDED` / `UNPRICED` |
| consumo por TENTATIVA | `studio_runs`: `input_tokens`, `output_tokens`, `estimated_cost_usd`, `route`, `model` |

**Nenhum contador novo foi criado.** O adendo proíbe um segundo gateway ou
ledger, e ele estava certo: a autoridade existe.

## 2. O que faltava — e o que esta fatia fecha

O que faltava era a **apresentação**: o consumo por tentativa é gravado e
nunca foi mostrado. A tarefa tem agora um painel "Uso e custos".

O que ele mostra sai só do que está registrado, e a regra que o adendo escreve
é a que este módulo garante:

- **uso desconhecido NUNCA vira zero.** Uma tentativa sem consumo registrado
  não é uma tentativa de zero token. `null` é `null`, e a tela escreve "não
  registrado";
- **zero REGISTRADO continua sendo zero** — as duas ausências não se colapsam
  na mesma frase;
- **evento repetido não duplica custo.** O corpo da tarefa traz a tentativa
  corrente duas vezes, em `runs` e em `current_run`; a soma é por
  identificador;
- a linha que impede o resto de mentir: **quantas tentativas rodaram sem
  registro**. Sem ela, uma soma parcial parece o custo inteiro.

E o painel diz, por escrito, que o número é ESTIMADO pelo preço configurado
aqui — não é a fatura do provedor, e **não há cota de assinatura medida neste
produto**. Os cinco números do adendo continuam distintos porque os três que
ninguém mede não aparecem.

## 3. Falsificação

| sabotagem | resultado |
| --- | --- |
| `?? 0` no lugar de preservar a ausência | **PEGA**, em 2 testes |
| somar a lista sem agrupar por identificador | **PEGA** — a tentativa corrente dobrava |

## 4. Provas

| prova | resultado |
| --- | --- |
| `uso.spec.ts` | 6 |
| suíte `studio-web` | 646 |
| e2e com axe | o painel abre depois de uma criação real no servidor de teste, mostra "não registrado" e **não** mostra `US$ 0.0000` |

**Limitação declarada:** esta é a fatia B do adendo, e só em parte. Faltam a
reserva concorrente, a conciliação, os alertas (fatia C) e os demais provedores
(fatia D). Cota de assinatura e custo informado pelo provedor não existem em
lugar nenhum do código — e por isso não têm linha na tela. A jornada com
provedor real continua em `EB-04`.
