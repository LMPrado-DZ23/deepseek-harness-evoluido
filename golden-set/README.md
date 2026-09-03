# Golden set P32

São 18 briefs escritos como pessoas leigas costumam pedir: três em cada uma de
seis categorias. Landing page e catálogo são executáveis nesta fatia. Agenda,
CRM, painel e portal são `NOT_IMPLEMENTED` e nunca entram no numerador.

`pnpm golden` usa fixtures determinísticas, executa build, Vitest, Playwright,
axe e scan sem rede e registra que o LLM real ficou `NOT_EXECUTED`. Definir
`DZ23_GOLDEN_LLM=1` falha fechado como `NOT_CONFIGURED` até o adapter real ser
ligado ao runner. Só uma execução com LLM real poderá medir a promoção D21.
