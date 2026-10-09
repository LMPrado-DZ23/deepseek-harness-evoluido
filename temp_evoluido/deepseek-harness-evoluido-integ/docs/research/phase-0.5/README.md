# Fase 0.5 — kit de pesquisa com pessoas leigas

**Estado:** `SCHEDULED_AFTER_PHASE_9`

Por decisão E4, este kit será adaptado para observar cinco pessoas sem
experiência técnica usando o DZ23 STUDIO completo, depois do gate do Windows
(fase 9) e antes do piloto (fase 10). A construção de P32, P33 e P31-B está
liberada; a experiência para leigos permanece `NOT_VALIDATED` até este gate.

O teste não transforma prova focada, preview ou staging em aplicação pronta.
Ele mede linguagem, compreensão do fluxo e confiança calibrada no produto
integrado. Piloto e release público continuam bloqueados até resultado `GO`.

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
- [`recording-consent.md`](recording-consent.md): termo opcional, separado,
  usado somente se houver gravação;
- [`preparation-proof.md`](preparation-proof.md): comandos, resultados e
  bloqueios do preparo técnico;
- [`claude-handoff.md`](claude-handoff.md): estado técnico para continuidade
  entre Codex e Claude.

## Fronteira com o OmniSeek e o kit antigo

O P39 mantém todo `omniseek/**` fora do artefato do DZ23 STUDIO. O fluxo P40
**Ideia → Perguntas → Plano → Criação → Verificação** permanece somente como
referência inicial, não como decisão final de experiência.

O kit `cdd2edb` e seus formulários ficam preservados como base metodológica. Os
lançadores que apontam para o OmniSeek P40 são legados e não devem ser usados no
gate final. Depois da fase 9, lançador, preflight e `LEIA-ME-PRIMEIRO.md` serão
regenerados para o DZ23 STUDIO sem enfraquecer a prova negativa de rotas
externas.

O preflight adaptado continuará iniciando o produto com ambiente mínimo. Chaves,
logins de CLIs e endereços externos existentes no computador não serão
herdados. O perfil privado continuará restrito a IA local em loopback.

## Ordem correta

1. A equipe conclui o gate multiplataforma e Windows da fase 9.
2. O facilitador executa o preflight adaptado e prepara um navegador sem dados
   pessoais.
3. Cada participante recebe um identificador anônimo `P01` a `P05`.
4. O participante realiza o fluxo sem orientação de interface.
5. O facilitador registra fatos e frases literais, sem interpretar durante a
   sessão.
6. Depois das cinco sessões, a equipe preenche o scorecard e decide `GO`,
   `ITERATE` ou `NO_GO`.

Sem gravação por padrão. Quando houver consentimento específico, áudio, vídeo
ou tela são apagados em 30 dias; somente resultados anônimos podem ser
conservados. P32, P33 e P31-B podem começar antes deste gate por E4. O `GO`
continua obrigatório para piloto e release público.
