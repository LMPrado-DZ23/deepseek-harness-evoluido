# Handoff Codex → Claude — E4 e abertura de P32/P33/P31-B

## P32/P33 + P31-B fatia 1 — fechamento para revisão Claude

Base da revisão: `ab0fe506928dacd736262a024d202f3e96e2689d..HEAD` na branch
`codex/p32-fatia1-prompt-to-app`. Não houve merge, push, PR ou deploy.

### O que foi construído

- Sete domínios novos tenant-aware e catálogo único de 19 domínios Studio.
- AppSpec v1, detecção/confirmação de dados sensíveis, intake de uma pergunta
  por vez, recomendação marcada, plano e aprovações T1.
- Máquina auditada sem READY/DONE/PUBLISHED/DEPLOYED.
- Gerador cercado pelos arquivos do plano, template imutável e até três
  tentativas com falhas distintas de geração, build e testes.
- Template Vite/React/TypeScript/Tailwind/Vitest/Playwright/axe com lockfile;
  setup T2 prepara store offline e imagem fixada.
- Construtor Docker sem rede, não privilegiado, `CapDrop=ALL`,
  `no-new-privileges`, usuário não root, raiz somente leitura, memória
  compartilhada privada e somente a run gravável.
- API `/api/studio/apps` com sessão, CSRF, contratos de rota e escopo derivado
  da membership. O teste adversarial tenta ler e alterar projeto de outra
  organização por path, query e body e recebe 404/400 sem mutação.
- Interface DZ23 STUDIO responsiva nas cinco etapas, com texto de privacidade
  diferente em `local-only` e `any`; o aviso permanente aparece somente em
  Criação/Verificação. Interface e servidor têm catálogos pt-BR versionados.
- Golden set: 18 briefs (três em seis categorias). Landing page e catálogo têm
  seis execuções determinísticas; agenda, CRM, painel e portal são doze
  `NOT_IMPLEMENTED`. LLM real fica `NOT_EXECUTED` e promoção é falsa.

### Evidências executadas em WSL2/ext4

- PostgreSQL real: **250/250** testes; cobertura global 94,59% statements e
  91,94% branches. Identidade, policy, tenancy, agentes, rotas,
  `storage-postgres` e controles críticos do Prompt-to-App em 100%.
- Interface: 3/3 testes unitários; build de produção PASS.
- Playwright em servidor HTTP efêmero: 2/2; 401 sem sessão em `/studio` e API;
  jornada autenticada com CSRF; axe com zero violações. Executado dentro da
  imagem fixada sem rede e sem privilégios.
- `gate:i18n`: PASS, 79 chaves; `gate:domain-scopes`: PASS.
- Isolamento real do construtor: PASS, conexão externa recusada e trust store
  do host com SHA-256 idêntico antes/depois.
- Pipeline técnico completo: `VERIFIED_PROTOTYPE`, uma tentativa, build,
  Vitest, Playwright e axe PASS; arquivo sentinela externo inalterado; tenant B
  recebeu `NOT_FOUND`. LLM real `NOT_EXECUTED`.
- Golden set: `PASS_DETERMINISTIC`, 18 totais, 6 executáveis, 12
  `NOT_IMPLEMENTED`, LLM real `NOT_EXECUTED`; não elegível para promoção D21.
  A prova negativa com `DZ23_GOLDEN_LLM=1` falha fechada como
  `NOT_CONFIGURED` enquanto o adapter real não estiver ligado.
- Profile com lockfile congelado; `dump-config` real: policy 579, identity 605,
  tenancy 607, agents 609, route-health 617, Prompt-to-App 619, web 621 e hello
  623.
- Provas anteriores reexecutadas: runtime GO, agentes/rotas GO, borda GO e
  Postgres runtime GO com os 19 domínios carregados. P37: PASS, 15.061 arquivos
  examinados e sem achados.
- Upstream permanece limpo em
  `6c705be1ce6774a000d061da41d1823b03a3d42c`.

### Classificação honesta

Prompt-to-App fatia 1 = **BETA**. Preview e publicação = `NOT_PRESENT`.
Agenda/CRM/painel/portal = `NOT_IMPLEMENTED`. LLM real, celular físico e fase
0.5 = `NOT_EXECUTED`/`NOT_VALIDATED`. O E2E da interface usa API determinística
em memória; contratos reais, sessão/CSRF, tenant e pipeline são provados nas
suítes e provas separadas.

Arquivos de prova: `docs/proofs/P32-builder-isolation-proof.md`,
`P32-template-pipeline-proof.md`, `P32-prompt-to-app-fatia1-proof.md`,
`P32-studio-web-e2e-proof.md` e `golden-set/reports/2026-09-03-deterministic.*`.
ADRs 017–020 registram fluxo/i18n, domínios/estados, template e isolamento.

Decisões do Prado continuam fora desta branch e não bloqueiam a revisão:
retenção de pesquisa em 30 dias e licença open source exata antes do primeiro
push. O `LICENSE.md` proprietário existente não autoriza redistribuição.

## P32/P33 fatia 1 — estado em 03/09/2026

- Branch isolada criada: `codex/p32-fatia1-prompt-to-app`, base exata
  `ab0fe506928dacd736262a024d202f3e96e2689d`.
- Prado escolheu a estrutura visual recebida em
  `docs/design/p32-fatia1-layout-reference.png`; a adaptação vinculante para
  DZ23 STUDIO está em `docs/design/p32-fatia1-dz23-safe-concept.png` e
  `docs/design/P32-FATIA1-DESIGN-SPEC.md`.
- A adaptação remove Publicar/Publicação e fixa as etapas Ideia → Perguntas →
  Plano → Criação → Verificação, com aviso permanente de protótipo não
  publicado.
- A construção está em andamento, sem commit. Já existem os sete domínios
  tenant-aware, AppSpec, intake, planner, gerador cercado, pipeline de até três
  tentativas, executor de contêiner e a interface React/Vite responsiva.
- A auditoria prévia confirmou que `ctx.sandbox` governa somente efeitos de
  arquivo e não prova isolamento de rede, processo ou syscall. Por isso,
  geração/build/test usam executor de
  contêiner descartável, `--network none`, sem privilégios, `cap_drop ALL`,
  `no-new-privileges`, root filesystem somente leitura e montagem gravável
  restrita ao diretório da run. `ctx.sandbox` continua disponível para tarefas
  que só exigem política de arquivo, mas não pode ser chamado de isolamento de
  rede. Sem backend isolado disponível, a geração falha fechada como
  `BLOCKED_EXTERNAL`/`sandbox: unavailable`; não roda em modo parcial com rede.
- A cerca de escrita agora cruza a resposta da IA com `planned_files`: arquivo
  fora do plano é recusado; arquivo original do template nunca é sobrescrito;
  alteração futura de arquivo previamente gerado exige autorização explícita.
  O teste permanente cobre os três casos.
- A API `/api/studio/apps` deriva org, tenant e papel da sessão/membership no
  servidor, exige CSRF nas mutações e cobre saúde, projetos, perguntas, plano,
  aprovação e geração. Nenhuma rota aceita escopo fornecido pelo cliente.
- O plugin `@dz23-studio/web` serve o build em `/studio` no mesmo webserver,
  exige sessão em todos os arquivos, recusa traversal/symlink/mutações e envia
  CSP restritiva. Não abre porta própria.
- Requisições de IA vindas da web recebem escopo interno via `markScope`; custo
  e saúde não caem no tenant de sistema e nenhum header de escopo é aceito.
- Verificação intermediária no ext4/WSL2: typecheck PASS, 41/41 testes focados
  PASS, builds de `@dz23-studio/studio-web-app`, prompt-to-app e web PASS. O
  `--dump-config` real contém os plugins nas linhas 619-622. Ainda não são o
  gate final da fatia e não provam o contêiner real, E2E de navegador ou golden
  set.
- `docs/research/REFERENCIAS_VISUAIS_GERACAO.md` registra bolt.diy,
  Open-Laudable e OpenDesign somente como referências. OpenDesign fica para a
  fatia 2/P34 e depende de inventário P37 específico antes de qualquer cópia.

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
