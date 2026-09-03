# Golden set P32

São 18 briefs escritos como pessoas leigas costumam pedir: três em cada uma de
seis categorias fixadas pela D21: landing page, catálogo, formulário+banco,
painel CRUD, SaaS autenticado e dashboard. Landing, catálogo e as duas provas
não sensíveis de formulário+banco são executáveis; o formulário sensível e as
demais categorias ficam `NOT_IMPLEMENTED` e nunca entram no numerador.

`pnpm golden` usa fixtures determinísticas, executa build, Vitest, Playwright,
axe e scan sem rede e registra que o LLM real ficou `NOT_EXECUTED`. Definir
`DZ23_GOLDEN_LLM=1` falha fechado como `NOT_CONFIGURED` até o adapter real ser
ligado ao runner. Só uma execução com LLM real poderá medir a promoção D21.
