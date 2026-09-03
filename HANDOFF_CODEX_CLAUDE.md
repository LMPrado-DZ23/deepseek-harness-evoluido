# Handoff Codex → Claude — E4 e abertura de P32/P33/P31-B

Base anterior à E4: `codex/p30-policy-foundation@c8d73f5`. A Fase 3 está fechada e integrada
localmente. Sem push, PR ou deploy.

## Decisão vinculante do Prado

E4 revoga a fase 0.5 como pré-requisito de construção. P32, P33 e P31-B podem
começar agora. A fase 0.5 passa a testar o DZ23 STUDIO completo depois do gate
Windows da fase 9 e antes do piloto da fase 10.

Até cinco sessões `VALID` produzirem `GO` no gate 4/5:

- experiência para pessoas leigas = `NOT_VALIDATED`;
- piloto e release público permanecem bloqueados;
- documentação e interface não podem chamar preview, staging, teste focado ou
  mock de “aplicação pronta”.

## Regras para a construção liberada

1. Fluxo inicial de referência: **Ideia → Perguntas → Plano → Criação →
   Verificação**, vindo do OmniSeek P40 sem incorporar seu código.
2. Textos, ordem das etapas e glossário em arquivos de linguagem separados e
   versionados, pt-BR primeiro.
3. Estados operacionais verdadeiros. Nenhum deploy além de `PREVIEW_OK` e
   `STAGING_OK` nas fases autorizadas.
4. P31-B cria domínios tenant-aware para projeto, execução, aprovação e
   evidência sobre o storage já construído; o log de sessão do Harness não é
   substituído.
5. Revisão Claude de cada fatia de interface inclui linguagem comum.
6. Pesquisa sem gravação por padrão; gravação consentida é apagada em 30 dias,
   preservando somente resultados anônimos.

## Próximo prompt pedido ao Claude

Fornecer o prompt consolidado da primeira fatia vertical de P32/P33/P31-B. Ele
deve preservar E4, D02 (zero diff upstream), D14 (tenant-aware), D21 (golden
set), D30 (cobertura), tiers T0–T3 e nenhum deploy de produção.

## Histórico verificado da Fase 3

1. Confirmar que `@dz23-studio/agents` é a única porta de Codex/Claude e que a
   concessão de policy exige ancestral coordenador + mesmo `cwd` de worktree.
2. Confirmar duas aprovações: início e aplicação da proposta.
3. Confirmar as quatro correções pedidas no parecer sobre `f134e4c`:
   - mudança do projeto principal preserva `PROPOSED`, marca
     `main_changed_during_run` e não percorre árvores não rastreadas;
   - aplicação compara `base_commit..HEAD` e bloqueia arquivo também alterado
     por commit posterior;
   - T3 consulta identidade forte no serviço de identidade e o run grava
     `approved_by`/`approved_at`;
   - `privacy: local-only` nunca escolhe rota externa e audita a recusa.
4. Conferir budgets, leases, tamper SHA-256 e conflito entre duas propostas.
5. Conferir fallback OmniRoute somente antes de conteúdo/tool, retry zero e
   que ele só se aplica a uma seleção `any` já autorizada.
6. Conferir que testes reais estão `NOT_EXECUTED`, não simulados como prontos.
7. Conferir a limitação declarada de SIGKILL no provider in-process e a prova
   parcial, não absoluta, do commit do Hermes.

Gates esperados no fechamento: 216/216 com PostgreSQL real e 100% nas quatro
métricas; PoC 3A, runtime, edge, Postgres runtime, domínios e P37 em PASS/GO.

Arquivos principais: `plugins/agents`, `plugins/route-health`,
`dsh-home/profiles/studio/cordis.patch.yml`, ADR-014, ADR-015 e prova P35.
