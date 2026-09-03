# ADR-017 — Fluxo Prompt-to-App e linguagem versionada

Status: aceito para a fatia 1.

O fluxo inicial é Ideia → Perguntas → Plano → Criação → Verificação. Ele usa o
OmniSeek P40 somente como referência de jornada; nenhum código foi incorporado.
Textos visíveis, ordem e glossário vivem em catálogos pt-BR versionados. O gate
`pnpm gate:i18n` percorre o frontend e o código-fonte de todos os plugins,
impede estados de prontidão, texto JSX direto, texto gerado por CSS e novos
literais pt-BR fora dos catálogos. Plugins anteriores à fatia mantêm uma base
congelada no commit `ab0fe506`; o plugin Prompt-to-App é verificado por inteiro.
A experiência continua `NOT_VALIDATED` até a fase 0.5 de E4.

Criação e Verificação exibem aviso permanente de que o resultado é um protótipo
local e não publicado. Ideia, Perguntas e Plano não exibem esse aviso permanente.
O texto de privacidade declara a rota escolhida e muda entre `local-only` e
`any`.
