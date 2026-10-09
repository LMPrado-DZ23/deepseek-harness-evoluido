# Matriz de capacidades — Engineering OS

Medida em 11/09/2026 por leitura do código, não por leitura de nome de arquivo.
Estados: `MISSING`, `PARTIAL`, `FUNCTIONAL`, `STRONG`.

`docs/CAPABILITY_MATRIX.md` continua sendo a matriz do **produto atual**
(Prompt-to-App). Esta aqui mede a distância até o **Engineering OS** da missão,
que é outra coisa. Duas matrizes porque são duas perguntas; fundi-las esconderia
a segunda.

## A leitura de uma frase

O repositório tem uma **fundação de execução e segurança forte** e **quase
nenhuma das camadas cognitivas** que um Engineering OS precisa. O que existe é
bom; o que falta é grande, e a maior parte do que falta não tem substituto
parcial escondido em outro nome.

## Fundação — o que já sustenta peso

| Capacidade | Estado | Evidência |
| --- | --- | --- |
| Policy Engine | FUNCTIONAL | `plugins/policy/src/index.ts` — tiers T0–T3, `policyDecisionSchema`, trilha encadeada por `previous_sha256`; `src/rbac.ts:roleAllows` |
| Approval Engine | FUNCTIONAL | `plugins/action-approval/src/service.ts`, `src/mutex.ts`; ponte em `plugins/assistant-bridge/src/approval.ts:requireTier3Approval` |
| Emergency Stop | FUNCTIONAL | `plugins/emergency-stop/src/service.ts:StudioEmergencyStopService` (`engage`/`release`/`#cancelEverything`, `UnprovenStop`) |
| Git Engine | FUNCTIONAL | `plugins/agents/src/git.ts:GitWorktreeManager`, `isolatedGitEnvironment`; `diff_sha256`, `main_changed_during_run` |
| Preview Engine | FUNCTIONAL | `plugins/preview/src/service.ts` + `plugins/preview-supervisor/` completo |
| Health system | FUNCTIONAL | `plugins/route-health/` inteiro com circuit breaker; `plugins/integration-hub/src/runtime.ts:integrationHealth` |
| Sandbox de execução | PARTIAL | Contêineres endurecidos em `plugins/preview-supervisor/src/docker-manager.ts:hardenedHost`. **Falta** a taxonomia por verbo (READ/WRITE/EXECUTE/NETWORK/PRIVILEGED/DESTRUCTIVE): hoje o modo é string solta |
| Tool Runtime | PARTIAL | Políticas e auditoria aqui (`plugins/policy`); o runtime de ferramenta é do Harness |
| MCP | PARTIAL | Cliente stdio real em `plugins/mcp-client/src/client.ts:openMcpConnection`; catálogo em `src/dispatch.ts`. **Falta health próprio de MCP** |
| Routing Engine | PARTIAL | `plugins/route-health/src/service.ts:chooseRoute`, `streamWithFallback`, `DEFAULT_ROUTE_CIRCUIT`. Modos são `privado-local`/`equilibrado`/`melhor-qualidade` — **não** os seis da missão |
| LOCAL_ONLY / privacidade | FUNCTIONAL | `plugins/route-health/src/service.ts:enforceRoutePrivacy`, propagado por todo o pipeline |
| Queue | PARTIAL | `plugins/prompt-to-app/src/jobs.ts:PromptToAppJobService`; leases com fencing em `plugins/runtime-governor/src/memory.ts`. **Sem scheduler temporal** |
| Recovery / checkpoint | PARTIAL | `plugins/prompt-to-app/src/checkpoint.ts:latestGreenCheckpoint`, `src/resume.ts:readResumeMarker`. Escopo: **uma execução de geração**, não uma missão |
| Evaluation | PARTIAL | `golden-set/` + `scripts/golden-set-comprehension.mjs`. Mede compreensão de brief, não engenharia |
| Browser QA | PARTIAL | Playwright real em `apps/studio-web/tests/`; geração de spec em `plugins/prompt-to-app/src/acceptance.ts`. **Sem QA visual** (diferença de imagem) |

## As ausências — e nenhuma delas tem substituto escondido

| Capacidade | Estado | O que existe no lugar |
| --- | --- | --- |
| Spec Engine | MISSING | `constitution`/`specify`/`clarify`/`converge`: zero ocorrências. Há um pipeline FIXO (`plugins/prompt-to-app/src/pipeline.ts:PromptToAppPipeline`) de intake→plan→generate→build→test→attest |
| Constitution Engine | MISSING | Nada. `docs/PRODUCT_CONSTITUTION.md` é documento para humano, não regra aplicada pelo planner |
| Context Engine | MISSING | `contextBudget`: zero. Só uma **vista** da compactação feita pelo Harness (`apps/studio-web/src/assistant/conversationState.ts:compactionView`) |
| Memory Engine | MISSING | Nenhuma das sete memórias. `plugins/runtime-governor/src/memory.ts` é homônimo enganoso: governa capacidade, não memória |
| Review independente / adversarial / convergência | MISSING | Papéis `reviewer`/`security` existem em `plugins/agent-team/src/roles.ts` só como **filtro de ferramenta** |
| Code Intelligence | MISSING | Sem busca por símbolo, grafo de dependências ou índice |
| Research Engine | MISSING | Busca web aparece só como capacidade **negada** (`plugins/agent-team/src/roles.ts:NETWORK_TOOLS`) |
| Learning Engine | MISSING | Nada |
| Provider Adapters reais | MISSING | Só nomes de rota (`ollama`, `deepseek-official`, `omniroute`) e um `StudioFakeAdapter` de PoC em `plugins/hello/src/index.ts` |
| Observabilidade correlacionada | MISSING | Existem `run_id`, `operation_id`, `call_id` — **sem `trace_id`** costurando missão→tarefa→agente→ferramenta |
| Task DAG com estados da missão | PARTIAL→MISSING | `plugins/agent-team/src/model.ts` tem `depends_on` e status próprios; **faltam** READY/BLOCKED/REVIEW/DONE |
| Mission Engine de escopo amplo | PARTIAL→MISSING | O checkpoint existente cobre uma geração de app |
| `MAX_MISSION_COST` | MISSING | Há orçamento por rota e por execução; não por missão |
| Feature Capability Registry | PARTIAL | Há estados de saúde por integração e por rota; **falta** o ciclo AVAILABLE→…→OPERATIONAL |

## O que esta matriz NÃO diz

Não diz que o projeto está mal feito. Diz que ele é **outro produto** do que a
missão descreve, e que a distância é de camadas cognitivas — especificação,
contexto, memória, revisão, aprendizado — e não de infraestrutura.

Não marque nada aqui como `FUNCTIONAL` sem citar arquivo e teste.
