# Fase 0.5 — kit de pesquisa com pessoas leigas

**Estado:** `PREPARED_NOT_EXECUTED`

Este kit permite observar cinco pessoas sem experiência técnica usando o fluxo
de protótipo antes de desenharmos os domínios e contratos definitivos do
Prompt-to-App.

O teste não aprova o OmniSeek como produto, não incorpora seu código ao DZ23
STUDIO e não prova prontidão para produção. Ele mede somente linguagem,
compreensão do fluxo e confiança calibrada.

## O que será medido

A pessoa deve conseguir explicar, sem receber a resposta, estas cinco etapas:

1. **Ideia:** contou o que gostaria de criar.
2. **Perguntas:** esclareceu decisões importantes.
3. **Plano:** conferiu o que seria feito antes da execução.
4. **Criação:** autorizou o sistema a produzir arquivos dentro do ambiente
   isolado.
5. **Verificação:** viu o resultado testado e distinguiu preview de produto
   pronto.

O gate principal exige que pelo menos quatro dos cinco participantes descrevam
as cinco etapas sem ajuda. Os bloqueios de segurança são absolutos: nenhuma
credencial real, ação externa, publicação ou deploy pode ocorrer.

## Arquivos do kit

- [`participant-card.md`](participant-card.md): única instrução inicial lida à
  pessoa participante;
- [`facilitator-protocol.md`](facilitator-protocol.md): preparação, condução e
  encerramento de cada sessão;
- [`observation-form.md`](observation-form.md): uma cópia por participante;
- [`gate-scorecard.md`](gate-scorecard.md): consolidação dos cinco resultados;
- [`preparation-proof.md`](preparation-proof.md): comandos, resultados e
  bloqueios do preparo técnico;
- [`claude-handoff.md`](claude-handoff.md): estado técnico para continuidade
  entre Codex e Claude.

## Fronteira com o OmniSeek

O P39 mantém todo `omniseek/**` fora do artefato do DZ23 STUDIO. O kit apenas
verifica e inicia, como protótipo separado, o checkout P40 no commit
`d9a8109528839a9f6c691cab9d71f3fce7e91e02`.

O ZIP gerado pelo script `scripts/build-phase05-kit.ps1` contém formulários e
lançadores, mas deliberadamente não contém wheel, fonte ou dependências do
OmniSeek. O notebook precisa ter o checkout P40 e seu ambiente Python já
preparados e auditados.

## Ordem correta

1. O facilitador executa o preflight e prepara um navegador sem dados pessoais.
2. Cada participante recebe um identificador anônimo `P01` a `P05`.
3. O participante realiza o fluxo sem orientação de interface.
4. O facilitador registra fatos e frases literais, sem interpretar durante a
   sessão.
5. Depois das cinco sessões, a equipe preenche o scorecard e decide `GO`,
   `ITERATE` ou `NO_GO`.

P32 e P31-B só podem começar após o gate `GO` desta fase.
