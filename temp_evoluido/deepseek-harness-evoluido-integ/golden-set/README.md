# Golden set P32

São 18 briefs escritos como pessoas leigas costumam pedir. O conjunto cobre
landing page, catálogo, formulário+banco, painel CRUD, área autenticada,
dashboard e uma agenda interna especializada derivada de `form-database-01`.
Todos os 18 casos têm executor determinístico. Na agenda, a prova criada pelo
Studio exercita criação, conflito de horário, escopo por membro, confirmação
pelo proprietário, cancelamento pelo próprio membro e liberação do horário.

`pnpm golden` usa fixtures determinísticas, executa build, Vitest, Playwright,
axe e scan sem rede, exige que toda checagem técnica termine em `PASSED` e
mantém cada critério de produto não automatizado na coluna `NOT_AUTOMATED`.
O relatório separa explicitamente “pipeline técnico verificado” de “critério
de produto atendido”; 18 builds verdes não significam que todos os pedidos dos
briefs foram implementados. Também registra que o LLM real ficou
`NOT_EXECUTED`. Definir
`DZ23_GOLDEN_LLM=1` falha fechado como `NOT_CONFIGURED` até o adapter real ser
ligado ao runner. Só uma execução com LLM real poderá medir a promoção D21.
