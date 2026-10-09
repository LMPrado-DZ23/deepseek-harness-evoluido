# PLANO MESTRE v2.0 — "Harness Studio" (codinome: DeepSeek Harness Studio)

**Natureza:** versão revisada do Plano Mestre v1.0 (01/09/2026), consolidada após quatro rodadas de debate Claude × Codex. Substitui o v1.0 onde conflitar. Onde o v1.0 não é citado, permanece válido.
**Status do debate:** encerrado por convergência arquitetural. Sem divergência material pendente. Restam provas de execução (cap. 7) e decisões exclusivas do Prado (cap. 8).
**Base de evidência:** PDF v1.0; código-fonte inspecionado de deepseek-harness (0.1.2-alpha.1), 9router (0.5.59), caveman (2.4.0), Adorable (snapshot), code-server (snapshot); README público do hermes-agent; baseline parcial do Codex em Windows/ZIP.

---

## 0. O que mudou em relação ao v1.0 (resumo executivo)

O v1.0 acertou em governança, segurança e honestidade de estados. Errou o dimensionamento: presumiu uma equipe de seis papéis, entregou valor para o leigo só na fase 7, e propôs construir do zero o que o Harness já tem (gateway de modelos, adapters de CLI, scheduler, sandbox, credenciais, telemetria). Subestimou o que falta de verdade: identidade, tenants, RBAC, TLS, Prompt-to-App, preview/staging, PWA e linguagem para leigos.

O v2.0 troca "construir camadas" por **"compor sobre os seams do Harness e construir só o que não existe"**, corta a v1.0 para uma fatia vertical, coloca o trust plane como primeira construção nova, e congela 30 decisões com evidência.

### Registro de revisão pós-v2.0 — Errata E4 (03/09/2026)

Por decisão do Prado, a fase 0.5 deixa de ser pré-requisito da construção de
P32, P33 e P31-B. Ela passa a testar a usabilidade do **DZ23 STUDIO completo**
depois do gate do Windows (fase 9) e antes do piloto (fase 10). O protocolo
continua exigindo cinco sessões `VALID`, gate 4/5 e decisão
`GO / ITERATE / NO_GO`.

Até o `GO`, são proibidas afirmações de que a experiência foi validada para
pessoas leigas, o piloto, qualquer release público e linguagem equivalente a
“produto pronto”. P32/P33/P31-B podem ser construídos agora, desde que textos,
ordem das etapas e glossário permaneçam em arquivos de linguagem pt-BR
separados e versionados. O fluxo do OmniSeek P40 é somente referência inicial:
**Ideia → Perguntas → Plano → Criação → Verificação**. Deploy continua limitado
a estados verdadeiros `PREVIEW_OK` e `STAGING_OK`.

Risco aceito: problemas de linguagem podem ser descobertos mais tarde e custar
mais para corrigir. Mitigação: linguagem desacoplada da lógica e revisão do
Claude em cada fatia de interface. Pesquisa sem gravação por padrão; quando
autorizada, a gravação é apagada em 30 dias e somente resultados anônimos podem
ser conservados.

---

## 1. Decisões congeladas (não reabrir sem evidência nova)

| ID | Decisão | Origem |
|---|---|---|
| D01 | O DeepSeek Harness é o núcleo e único orquestrador. Gateways, CLIs, agentes externos e plugins nunca controlam o projeto. | v1.0, C2 |
| D02 | **Zero diff no upstream.** Todo código do Studio vive em repositório próprio (plugins Cordis, profile, `cordis.patch.yml`). Necessidade de alterar o Harness = achado → issue/PR upstream; exceção temporária exige ADR, teste, prazo de remoção e plano de upstreaming. | O1 |
| D03 | Harness fixado por **commit Git** (`github.com/deepseek-ai/deepseek-harness`), consumido como dependência. Upgrade = migração de dados testada em cópia, com rollback. Mesmo tratamento para `vendor/cosmokit` e `vendor/schemastery`. | C18 |
| D04 | v1.0 = fatia vertical: ideia → perguntas simples → plano → geração Next.js/React → preview → testes → aprovação → **staging**. Sem deploy autônomo em produção. | C1 |
| D05 | Celular na v1.0 = PWA que controla, aprova e acompanha; execução pesada no computador/servidor autorizado. Shells nativos (Capacitor/desktop) = v1.x. | C1, C12 |
| D06 | Sem prazo em calendário antes de baseline e PoCs. Cada gate tem faixa de esforço P/M/G e **critério de abandono em 2×**. | O7 |
| D07 | Modelos: seam `ctx.llm`. OmniRoute e 9Router entram como **rotas configuradas no `llm-pi-ai`** (OpenAI-compatible), não como pacotes de gateway. Adapter dedicado só se streaming, tools ou `usage` falharem no PoC. Plugin separado para saúde/custo/consumo por rota. | C15 |
| D08 | Um gateway ativo por requisição; nunca encadear OmniRoute e 9Router. Uma única autoridade de retry: com gateway ativo, retry do adapter = 0–1; fallback Direct **só antes do primeiro token**; nunca após tool call, efeito externo ou início de stream; toda troca de rota gera evento auditável. | O4 |
| D09 | 9Router: **externo, avançado, não empacotado, fora da interface na v1.0.** Proibido: instalar CA raiz, alterar `hosts`, ocupar/redirecionar 443, empacotar handlers MITM, automatizar interceptação de Copilot/Kiro/etc., mostrar isso a leigos. | O8 |
| D10 | Agentes/CLIs: seam de **subagente** do Harness (`subagent-codex`, `subagent-claude-code`, `subagent-acp`). Nenhum "AgentAdapter" paralelo. | C16 |
| D11 | Hermes = v1.x: sem ACP (até prova no código), adapter de processo/RPC estruturado com cancelamento, runtime Python 3.11/uv isolado, subagentes e memória próprios desativados. Não bloqueia v1.0. | C16, R3 |
| D12 | Coordenação: `ctx.jobs` + `jobs-local` + evolução do `experimental/agent-team`. Sem Redis, sem pg-boss na v1 (reconsiderar só com runners remotos concorrentes). | C4 |
| D13 | Sandbox: `ctx.sandbox` do Harness (bwrap/Landlock, Seatbelt, Windows ACL restricted-token; E2B remoto). UI mostra `full` / `partial` / `unavailable`; Windows sem WSL2/contêiner = parcial, com recomendação explícita. Fail-closed mantido. | C13 |
| D14 | Dados: log de sessão append-only do Harness **não é substituído**. `ctx.storage` com SQLite (pessoal) e **Postgres 16** (servidor/equipe) via novo backend `storage-postgres`; `org_id`/`tenant_id` obrigatórios nos domínios compartilhados; mesma suíte de contrato nos dois backends. | C3 |
| D15 | Policy engine em **TypeScript + Zod**, aplicado no executor (não só na UI), estendendo authorization, permission presets, user approval e sandbox policy existentes. OPA/Cedar = alternativa futura registrada em ADR. | C6 |
| D16 | Tiers de aprovação T0–T3 (cap. 4). **Tier ausente ou inválido → T2.** MCP externo nunca abaixo de T1. Conflito manifest × policy → mais restritivo. Plugin não assinado bloqueado no canal estável. | C5, O2 |
| D17 | Segredos: referências, nunca valores. Providers do seam `ctx.credentials`: Windows Credential Manager, macOS Keychain, Linux Secret Service; servidor: Infisical ou Vault; `.env` só compatibilidade temporária de desenvolvimento. | C7 |
| D18 | **Trust plane é a primeira construção nova** e prioridade máxima: identidade (OIDC/passkeys), sessão de dispositivo revogável, organizações/tenants, RBAC/ABAC, TLS, origin policy, rate limiting, auditoria. Nenhum bind em `0.0.0.0` antes disso. | C17 |
| D19 | Acesso móvel interino (uso interno) só via proxy autenticado — preferência Tailscale com identidade/ACL; alternativas Cloudflare Access ou Caddy TLS em rede privada. Basic Auth nunca como única proteção pública. Harness sempre em loopback. Rótulo EXPERIMENTAL na matriz. | O5 |
| D20 | Telemetria: OpenTelemetry como exportação; pessoal = local com retenção curta; servidor = OTLP Collector; redaction antes de exportar; painel simples de custo/falhas/duração/ações. Spans não vão para o banco transacional. | C14 |
| D21 | Golden set Prompt-to-App: ≥ 18 briefs (3 por categoria: painel CRUD, SaaS autenticado, landing, catálogo, formulário+banco, dashboard) em linguagem leiga. Promoção exige ≥ 80% geral, **100% nos controles críticos de segurança/privacidade**, zero exposição de CPF/saúde/credenciais, intake sem jargão, relatório comparativo. | C8, O3 |
| D22 | Teste com ≥ 5 leigos sobre o produto completo depois da fase 9 e antes do piloto; não bloqueia P32/P33/P31-B, mas bloqueia piloto e release público até `GO`. | C10, E4 |
| D23 | Modelo econômico interno: BYOK + Ollama. Versão pública: configuração assistida ou créditos gerenciados com limite — **decisão do Prado**. | C9 |
| D24 | "DeepSeek Harness Studio" é **codinome** até revisão de marca. Nome público = decisão do Prado, registrada em ADR antes do release candidate. Mesma checagem nominativa para Hermes, OmniRoute, Caveman (marca pendente, classes 9 e 42). | C11, O9 |
| D25 | Custos de code signing (Windows/macOS), Apple Developer e Google Play entram no orçamento antes de prometer distribuição nativa. | C12 |
| D26 | Caveman: partes MIT (`skills/`, `packages/agent/`) candidatas após inventário arquivo a arquivo; partes BSL (`engine/, proxy/, cacheengine/, rewriter/, browse/, mcp/, shrink/, cavemem core, shared/platform/`) **proibidas no artefato público e no serviço a clientes**; uso interno do Prado separado; comercial só com licença. Compressão desligada por padrão, nunca automática em código/logs/erros. | O9 |
| D27 | Adorable: referência de jornada de intake, prompts, feedback visual, fluxo geração–preview e linguagem. Sem transplante de componentes React 19/Next 16; sem dependência Freestyle. | O10 |
| D28 | code-server: processo separado, token curto, base path por workspace, sempre atrás do proxy do Studio (mesmo com senha própria). | v1.0 7.5 |
| D29 | Baseline oficial do núcleo: **clone Git, commit fixado, WSL2 Ubuntu/Linux**, pnpm exato, install + typecheck + lint + test (sem E2E pago). Windows nativo tem **release gate próprio** (instalação, sandbox, FS, PowerShell, Prompt-to-App, preview, recuperação, atualização). Falhas classificadas em 5 classes (cap. 7). | O6 |
| D30 | Cobertura: upstream 100% (intocado); pacotes Studio ≥ 90% statements e branches; **100%** em autenticação, policy, tenant isolation, segredos, aprovação e deploy; contract tests e testes adversariais obrigatórios. Meta final sujeita a aprovação do Prado. | C19 |

Mantidos integralmente do v1.0: princípios 1.2, estados verdadeiros 3.5 e proof bundle B.4, regras de experiência para leigos 3.3, Next.js/React como caminho ouro único, catálogo privado assinado antes de marketplace, critério de completude por capability matrix (ESTÁVEL/BETA/EXPERIMENTAL/DESLIGADO/NÃO SUPORTADO), P00 como prompt mestre.

---

## 2. Arquitetura consolidada

### 2.1 Princípio: composição sobre seams, construção só do que falta

```
┌──────────────── Studio (repositório próprio, plugins Cordis) ────────────────┐
│  Modo simples (PWA React 18)   │  Prompt-to-App   │  Trust plane            │
│  Integration Hub (leigo)       │  AppSpec/planner │  Identity/Tenant/RBAC   │
│  Preview seguro / Staging      │  Golden set/eval │  Policy TS+Zod / Tiers  │
│  storage-postgres  │ credentials-{win,mac,linux,infisical} │ route-health   │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ cordis.patch.yml + profile "studio"  (zero diff)
┌───────────────────────────────▼──────── DeepSeek Harness (commit fixado) ────┐
│ ctx.llm (llm-deepseek, llm-pi-ai → OmniRoute/9Router/Ollama por config)      │
│ subagent (codex, claude-code, acp, in-process)  │ ctx.jobs + agent-team      │
│ ctx.sandbox (bwrap/Landlock, Seatbelt, Win ACL, E2B) │ ctx.fs/shell/terminal │
│ ctx.sessions (log append-only, SQLite/JSONL) │ ctx.storage (json, sqlite)    │
│ ctx.credentials │ mcp-client │ skills │ session-telemetry-otel │ sdk/acp     │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Mapa seam → decisão

| Necessidade | Mecanismo | Novo? |
|---|---|---|
| Modelos e gateways | `ctx.llm`; rotas `llm-pi-ai` | Config + plugin de saúde/custo |
| Agentes externos | seam de subagente | `subagent-hermes` (v1.x) |
| Background e coordenação | `ctx.jobs`, `agent-team` | Promoção do agent-team + orçamento/exclusão por arquivo |
| Isolamento | `ctx.sandbox` | Tradução `full/partial` para UI |
| Dados de sessão | `ctx.sessions` | Nenhum |
| Dados de produto | `ctx.storage` + `storage-domain` | `storage-postgres`; domínios Studio |
| Segredos | `ctx.credentials` | Providers keychain/vault |
| Aprovação e policy | authorization, permission presets, user-approval, sandbox policy | Policy engine + tiers |
| Integrações | `mcp-client`, skills | Integration Hub (UI leiga) + manifests |
| Telemetria | `session-telemetry-otel` | Destinos por topologia + painel |
| **Identity / Tenant / RBAC / TLS** | — | **Novo (contratos próprios)** |
| **AppSpec / Planner / Gerador Next.js** | — | **Novo** |
| **Preview seguro / Deploy staging** | — | **Novo (Preview, Deploy)** |
| **PluginTrust (assinatura)** | `plugin-inventory` (sem assinatura hoje) | **Novo** |

Contratos novos (versionados, Zod + JSON Schema): `Identity`, `Tenant`, `Policy/Tier`, `AppSpec`, `Preview`, `Deploy`, `PluginTrust`, `RouteHealth`. Os contratos `ModelGateway`, `AgentAdapter` e `WorkspaceDriver` do v1.0 são **retirados** (duplicavam seams).

### 2.3 Topologias na v1.0

| Topologia | Runner | Dados | Acesso | Status v1.0 |
|---|---|---|---|---|
| Local pessoal | Harness local, sandbox do SO | SQLite | loopback | ESTÁVEL (alvo) |
| Desktop com servidor local | idem + serviço | SQLite | loopback + proxy autenticado (D19) para celular interno | BETA |
| Servidor/equipe | Docker Compose; contêiner por workspace | Postgres 16 | após trust plane (D18) | BETA (após D18) |
| Celular | PWA (controle/aprovação) | — | via topologias acima | BETA |
| Kubernetes, runners remotos concorrentes, shells nativos, Hermes, 9Router na UI | — | — | — | v1.x |

### 2.4 Repositórios

`harness-upstream` (clone espelho, commit fixado, somente leitura); `studio` (monorepo pnpm: `packages/studio/*` seguindo a convenção `packages/<grupo>/<pkg>` do Harness, `apps/studio-web`, `profiles/studio`, `golden-set/`, `docs/adr/`); `studio-templates` (templates Next.js assinados, versões fixadas).

---

## 3. Escopo por versão

**v1.0 (produção verificada):** fluxo Ideia → Plano → Criação → Conferência → Publicação até staging; modo simples pt-BR/en WCAG AA; DeepSeek direto + OmniRoute por rota + Ollama; Codex e Claude Code por subagente; sandbox do SO com honestidade `full/partial`; trust plane completo (D18); Integration Hub com MCP/skills por manifest e tiers; preview privado; staging com artefato imutável; PWA; golden set; capability matrix publicada.

**v1.x:** Hermes; 9Router na UI; RemoteWorkspaceDriver/Kubernetes; shells Capacitor/desktop; plugin signing com trust store completo; inteligência de repositório com embeddings; produção com aprovação reforçada; créditos gerenciados (se decidido).

**Fora:** Caveman-BSL no produto público; marketplace público; deploy autônomo em produção; qualquer função MITM.

---

## 4. Tiers de aprovação, policy e segredos

| Tier | Definição | Exemplos | Aprovação |
|---|---|---|---|
| T0 | Leitura segura | ler arquivos do workspace, buildar, testar, preview local | automática, silenciosa |
| T1 | Alteração reversível no workspace | editar arquivos, commit em branch de trabalho, instalar dependência em allowlist | automática, notificada depois |
| T2 | Ação externa ou de maior impacto | custo acima do limite, chamada a integração externa, migration, deploy staging, instalar MCP/skill, **qualquer ação sem tier declarado** | confirmação em linguagem comum |
| T3 | Irreversível ou sensível | produção, segredos, exclusão de dados, rotação, escalonar sandbox para `danger-full-access` | identidade forte + janela + registro |
| — | Plugin não assinado | — | **bloqueado** no canal estável |

Regras: tier ausente/inválido → T2; MCP externo ≥ T1 sempre; rebaixar exige manifest explícito **e** policy; conflito → mais restritivo; toda decisão vira evento de sessão com motivo. Policy = dados declarativos validados por Zod, avaliados em TS no executor, testes de tabela ≥ 50 casos incluindo negação por default.

Segredos: `secret://alias` resolvido por provider do `ctx.credentials`; nunca em config, log, trace, cliente ou celular; teste automatizado de ausência de valores no proof bundle.

---

## 5. Fases revisadas (gates, esforço, abandono)

| # | Fase | Depende | Esforço | Gate de saída | Abandono (2×) |
|---|---|---|---|---|---|
| 0 | Preservação, inventário Git e baseline WSL2 | — | P | `pnpm test` verde no clone/commit fixado em WSL2; inventário com URL+commit dos 7 projetos; SBOM; classificação das falhas Windows (5 classes) | escalar: upstream instável |
| 0.5 | Teste de usabilidade do produto completo com 5 leigos | 9 | P | cinco sessões `VALID`; ≥ 4/5 descrevem as 5 etapas sem ajuda; glossário comum aprovado | piloto bloqueado |
| 1 | PoCs de viabilidade (C2, C15) + ADRs + contratos novos | 0 | M | PoC "hello" com zero diff upstream (cap. 7.1); OmniRoute PASS/FAIL (7.3); ADRs D02–D30; schemas Zod dos contratos novos; policy engine com testes de tabela | reabrir D01 |
| 2 | **Trust plane** (D18) | 1 | G | nenhuma rota responde sem sessão válida com `host: 0.0.0.0`; tenant isolation testada adversarialmente; RBAC 100% cobertura; audit log append-only; revogação de dispositivo funciona | escalar |
| 3 | Composição de modelos e agentes | 1 | P–M | rotas DeepSeek/OmniRoute/Ollama com saúde/custo; Codex e Claude Code via subagente com cancelamento e orçamento; falha injetada (D08) verde | adapter dedicado |
| 4 | Storage Postgres + domínios Studio | 1 | M | contract tests `ctx.storage` verdes em SQLite e Postgres 16; `tenant_id` em 100% dos domínios; migração pessoal→equipe por export/import | — |
| 5 | Prompt-to-App (AppSpec, planner, gerador Next.js, golden set) | 3 | G | projeto gerado compila em ambiente limpo; golden set ≥ 18 com relatório; D21 atendido; loop gerar→build→testar→corrigir limitado | reduzir categorias |
| 6 | Preview seguro + staging | 2, 5 | M | preview privado com proxy autenticado, TTL, SSRF/host header testados; staging com artefato imutável, SBOM, provenance; rollback demonstrado | — |
| 7 | PWA e modo simples completo | 2, 5 | M | fluxos críticos em viewport móvel e dispositivo real; perda de rede não duplica comandos; celular sem segredos; WCAG AA | — |
| 8 | Integration Hub + manifests + tiers na UI | 2, 3 | M | conectar/testar/desligar MCP e skill por cartão; tiers exibidos; kill switch por projeto/org | — |
| 9 | Qualidade multiplataforma + Windows release gate | todas | M–G | core gate Linux verde; Windows release gate verde; matriz assinada; a11y/perf aprovados | listar NÃO SUPORTADO |
| 10 | Piloto interno → beta → GA | 0.5, 9 | M | fase 0.5 em `GO`; DoD (cap. 9) com evidência; 2 rodadas com leigos ≥ 80% sem ajuda; revisão de marca (D24) e licenças (D26) concluídas | — |

Fases 3 e 4 podem correr em paralelo com a 2; por E4, a fase 5 pode começar
após a 3. A fase 0.5 ocorre depois da 9 e antes da 10. Após os PoCs da fase 1,
as faixas viram estimativa de calendário (D06).

---

## 6. Riscos atualizados

| Risco | Mitigação/bloqueio | Decisão |
|---|---|---|
| Fork silencioso do Harness | zero diff, ADR para exceções | D02 |
| Upstream quebra formato de dados (pré-release declarado) | commit fixado, migração testada, rollback | D03 |
| Webserver do Harness sem auth/TLS exposto | trust plane primeiro, loopback + proxy interino | D18, D19 |
| Retry em cascata / tool call duplicada | autoridade única de retry, fallback só pré-token | D08 |
| MITM do 9Router em máquina de leigo | externo, não empacotado, seis proibições | D09 |
| Violação de BSL/marca (Caveman) | divisão MIT/BSL, gate de release | D26 |
| Marca "DeepSeek" em produto comercial | codinome, ADR de nome antes do RC | D24 |
| Dependência oculta (Freestyle via Adorable) | referência de fluxo apenas | D27 |
| Fadiga de aprovação / default inseguro | tiers com default T2 | D16 |
| Regressão silenciosa de geração | golden set com 100% em controles críticos | D21 |
| Velocidade × cobertura 100% | grupo Studio com meta própria | D30 |
| Runtime Python do Hermes | v1.x, isolado | D11 |
| Estimativas ausentes | P/M/G + abandono em 2× | D06 |

---

## 7. Provas pendentes (PoCs) — critérios objetivos

**7.1 Plugin "hello" com zero diff.** Repositório `studio` com profile `studio` que estende `web`; plugin registra uma tool, um provider `ctx.llm` falso e uma linha de domínio no `ctx.storage`. Verificações: `git -C harness-upstream diff --stat` vazio; `dsh --profile studio --dump-config` mostra as linhas do Studio; sessão persistida; aprovação e sandbox aplicados à tool; reinício do processo sem perder estado. Esforço P.

**7.2 Baseline WSL2/Git.** Clone no commit fixado; `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test`; relatório com PASS/FAIL por comando; falhas Windows nativo classificadas em: (a) ZIP/sem Git, (b) incompatibilidade real do Windows, (c) teste de rede/CLI mal posicionado, (d) flakiness/timeout, (e) defeito real. Classes (c) e (e) viram issues para upstream. Esforço P.

**7.3 OmniRoute como rota pi-ai.** Rota `api: openai-completions`, `baseURL` da instância local, `apiKeyEnv` por referência; medir streaming, tool calling, `usage` no stream, contagem de tokens; falha injetada (gateway derrubado a meio da resposta) → zero tool call duplicada, ≤ 1 tentativa extra, evento de troca de rota registrado. Se `usage` não vier no stream: adapter dedicado no molde do `llm-deepseek`. Esforço P.

**7.4 Postgres backend.** `storage-postgres` passa a mesma suíte de contrato do `storage-sqlite`; domínio de exemplo com `tenant_id`; teste adversarial de leitura cruzada entre tenants falha como esperado. Esforço M.

**7.5 Inventário de origem.** URL + commit/tag dos sete projetos (Harness e 9Router já identificados; Hermes = github.com/NousResearch/hermes-agent); SHA-256 do arquivo continua registrado, mas não substitui commit. Esforço P.

**7.6 Hermes modo estruturado (v1.x).** No código: existe execução única não interativa com saída estruturada e cancelamento? Existe API/RPC? Resultado decide entre adapter de processo e adapter RPC. Esforço P.

---

## 8. Decisões exclusivas do Prado (bloqueiam apenas o que indicam)

| Decisão | Bloqueia | Recomendação convergente Claude+Codex |
|---|---|---|
| Nome público do produto | release candidate | codinome até fase 10; ADR de nome |
| Modelo comercial da versão pública (assistido vs créditos com limite) | fase 10 pública | interna: BYOK + Ollama; pública: configuração assistida primeiro, créditos depois |
| Orçamento de code signing / Apple / Google | shells nativos (v1.x) | não prometer distribuição nativa antes |
| Meta de cobertura dos pacotes Studio | fase 1 (CI) | 90% statements+branches; 100% em segurança |
| Aceitar celular como cliente de controle na v1.0 | comunicação do produto | aceitar (já refletido em D05) |

---

## 9. Definition of Done v2.0 (adições ao cap. 10 do v1.0)

Acrescentar: `git diff` do upstream vazio no commit de release; inventário com commits; nenhum arquivo Caveman-BSL nem handler MITM no artefato; teste de que nenhuma rota responde sem sessão quando exposto; tenant isolation adversarial; golden set com relatório e 100% nos controles críticos; capability matrix mostra `enforcement` real do sandbox por plataforma; Windows release gate verde ou limitações listadas como NÃO SUPORTADO; ADR de nome e revisão nominativa de marcas de terceiros; proof bundle inclui `model-usage.json` (modelo, rota, tokens, custo) e `route-switch` events.

---

## Apêndice A — Prompts operacionais v2.0

Convenções: todo prompt herda o **P00** do v1.0 (governança), acrescido do bloco abaixo. Substituir `{…}`. Nenhum prompt autoriza deploy de produção, exposição de rede ou alteração do upstream.

**Bloco obrigatório adicional ao P00 (v2.0):**
```
REGRAS v2.0: (1) Nunca edite arquivos em {HARNESS_UPSTREAM}; se precisar, pare e registre "ACHADO UPSTREAM" com arquivo, linha e motivo. (2) Toda ação sem tier declarado é T2. (3) Segredos só por referência secret://alias. (4) Não instale CA, não altere hosts, não use porta 443. (5) Não adicione dependências de Caveman-BSL, Freestyle ou 9Router. (6) Registre esforço gasto vs faixa (P/M/G); ao atingir 2×, pare e apresente alternativas. (7) Saída: arquivos alterados, comandos e resultados reais, limitações, próximo gate.
```

### PoC-01 — Plugin hello com zero diff (fase 1, P)
```
Crie o repositório {STUDIO_ROOT} com um profile "studio" que estende o profile "web" do Harness em {HARNESS_UPSTREAM} (commit {HARNESS_COMMIT}) por cordis.patch.yml. Implemente um plugin @studio/hello que: registre uma tool "studio_echo" em ctx.tools; registre um provider falso em ctx.llm (rota "studio-fake") que responde stream determinístico; grave um registro tipado em ctx.storageDomain (domínio "studio.hello", campos tenant_id, created_at, note). Prove: dsh --profile studio --dump-config lista as linhas; uma sessão usa a tool; a tool passa por aprovação e sandbox; reinicie o processo e mostre a sessão e o registro preservados. Gate: git -C {HARNESS_UPSTREAM} diff --stat vazio; testes do plugin com 100% de cobertura. NÃO FAZER: editar packages/ do upstream; copiar código do upstream para o Studio; desativar sandbox ou aprovação para o PoC passar.
```

### PoC-02 — Baseline WSL2/Git e classificação Windows (fase 0, P)
```
Em WSL2 Ubuntu, clone https://github.com/deepseek-ai/deepseek-harness no commit {HARNESS_COMMIT}. Execute corepack enable; corepack prepare pnpm@11.7.0 --activate; pnpm install --frozen-lockfile; pnpm typecheck; pnpm lint; pnpm test. Não execute test:e2e. Produza baseline-report.md com PASS/FAIL por comando, duração e ambiente. Depois, no Windows nativo, execute apenas pnpm test e classifique cada falha em: (a) ZIP/sem Git, (b) incompatibilidade real do Windows, (c) teste de rede/CLI mal posicionado, (d) flakiness/timeout, (e) defeito real — com arquivo de teste e mensagem. Gere issues para (c) e (e). NÃO FAZER: corrigir código do upstream; chamar a baseline de aprovada se Linux não estiver verde; usar chaves de API reais.
```

### PoC-03 — OmniRoute como rota do llm-pi-ai (fase 1, P)
```
No profile studio, adicione ao llm-pi-ai a rota "omniroute" com api openai-completions, baseURL {OMNIROUTE_URL}, apiKeyEnv por referência, models {MODEL_LIST}, retryPolicy mínima. Meça e registre: streaming (chunks e ordem), tool calling (ida e volta), usage no stream, tokens contados vs reportados pelo OmniRoute, latência até primeiro token. Injete falha derrubando o OmniRoute no meio de uma resposta com tool call pendente e prove: zero tool call duplicada, no máximo uma tentativa adicional, evento de troca de rota com motivo/custo/tentativa, fallback para deepseek-official só se ocorreu antes do primeiro token. Resultado: omniroute-poc.md com GO (rota por config) ou NO-GO (adapter dedicado necessário, com o motivo exato). NÃO FAZER: encadear com 9Router; alterar llm-retry do upstream; ativar retries em duas camadas.
```

### P29 — Trust plane (fase 2, G)
```
Implemente, como plugins do Studio ao lado do host/webserver do Harness (sem alterá-lo): identidade OIDC + passkeys; sessão por dispositivo com revogação; organizações e tenants como domínio em ctx.storage; RBAC/ABAC integrado ao policy engine TS+Zod; TLS terminado em proxy reverso (Caddy) com origin policy e rate limiting; auditoria append-only de autenticação, autorização e aprovações. Testes obrigatórios com 100% de cobertura: nenhuma rota responde sem sessão válida com host 0.0.0.0; tentativa de leitura cruzada entre tenants falha; revogação de dispositivo invalida sessão ativa; tokens nunca aparecem em logs. Entregue threat model atualizado. NÃO FAZER: expor o Harness diretamente; Basic Auth como única proteção; armazenar segredos ou tokens em texto puro; tocar em packages/ do upstream.
```

### P30 — Policy engine e tiers (fase 1, M)
```
Implemente o policy engine do Studio em TypeScript + Zod, aplicado no pipeline de execução (tools/pre-execute) e não apenas na UI, estendendo authorization, permission presets, user-approval e sandbox policy do Harness. Tiers T0–T3 conforme o cap. 4 do Plano v2.0. Regras fixas: tier ausente ou inválido → T2; MCP externo nunca abaixo de T1; rebaixar exige manifest explícito e policy; conflito → mais restritivo; escalonar sandbox para danger-full-access é T3. Suíte de tabela com ≥ 50 casos, incluindo negação por default e tentativas de rebaixamento unilateral pelo plugin. Toda decisão gera evento de sessão com motivo. NÃO FAZER: introduzir OPA/Cedar; permitir bypass por flag de desenvolvimento; avaliar policy só no cliente.
```

### P31 — Storage Postgres e domínios Studio (fase 4, M)
```
Implemente storage-postgres como backend do seam ctx.storage do Harness, no repositório do Studio. Execute contra ele a mesma suíte de contrato do storage-sqlite e adicione testes de isolamento: todo domínio Studio declara tenant_id e org_id obrigatórios; leitura cruzada entre tenants deve falhar. Defina os domínios: projeto, run, aprovação, evidência, deploy, integração, uso/custo, auditoria. Migrations versionadas com preflight, backup e rollback; export/import para migrar de SQLite (pessoal) para Postgres (equipe). NÃO FAZER: substituir o log de sessão do Harness; introduzir Redis ou pg-boss; alterar storage-sqlite do upstream.
```

### P32 — Golden set e eval de Prompt-to-App (fase 5, M)
```
Crie golden-set/ com ≥ 18 briefs (3 por categoria: painel CRUD, SaaS autenticado, landing page, catálogo, formulário com banco, dashboard responsivo), escritos como pessoas leigas escrevem: vagos, com termos errados, com dados sensíveis implícitos (CPF, saúde). Para cada brief defina critérios automáticos: build limpo, testes do AppSpec, a11y automatizada, segurança básica (sem segredo hardcoded, sem exposição de dado sensível) e critério de intake (perguntas cobrem decisões materiais sem jargão). Pipeline que roda o conjunto a cada mudança de modelo, rota, prompt ou template e publica relatório comparativo. Promoção exige ≥ 80% geral e 100% nos controles críticos. NÃO FAZER: promover por média que esconda falha crítica; usar briefs escritos em linguagem técnica; rodar em todo commit (custo).
```

### P33 — Gerador Next.js e AppSpec (fase 5, G) — substitui P12/P13
```
Implemente intake conversacional (uma pergunta por vez, exemplos, opção "Não sei — recomende para mim") que produz AppSpec versionada (Zod): problema, personas, jornadas, entidades, permissões, integrações, requisitos não funcionais, dados sensíveis, critérios de aceite. Planner converte AppSpec em slices verticais. Gerador usa templates de {TEMPLATES_REPO} (Next.js, React, TypeScript estrito, Tailwind, shadcn, Zod, React Hook Form, Vitest, Playwright) com versões fixadas; execução dentro do ctx.sandbox do Harness; loop gerar → build → testar → diagnosticar → corrigir limitado a {MAX_ATTEMPTS}. Use o Adorable apenas como referência de fluxo e prompts. Gate: projeto gerado compila em ambiente limpo; golden set (P32) aprovado. NÃO FAZER: dependência Freestyle; transplantar componentes React 19/Next 16; marcar completo com auth/banco mock; promover preview a produção por nomenclatura.
```

### P34 — Preview seguro e staging (fase 6, M) — substitui P17/P18
```
Implemente Preview como recurso temporário e privado: build/run no workspace isolado, porta registrada, proxy reverso autenticado do Studio, URL curta, TTL, health, logs, stop; proteção contra SSRF, host header, DNS rebinding e exposição de env. Implemente DeployProvider para staging: artefato imutável com versão, commit, SBOM, provenance e assinatura; migrations com preflight, backup e plano forward/rollback; rollback demonstrado. Produção permanece desabilitada por policy (T3, fora da v1.0). NÃO FAZER: expor preview sem proxy; executar deploy real sem autorização; promover estado além de PREVIEW_OK/STAGING_OK.
```

### P35 — Composição de agentes via subagente (fase 3, P–M) — substitui P07/P08/P09
```
Configure no profile studio os providers subagent-codex e subagent-claude-code do Harness com orçamento, timeout, cancelamento e workspace isolado; nenhum AgentAdapter paralelo. Estenda experimental/agent-team (no Studio, sem editar o upstream) com orçamento por tarefa e exclusão por arquivo, sobre ctx.jobs. Teste: sucesso, falha, timeout, cancelamento, perda de processo, tool denial, tentativa de sair do workspace, conflito de escrita. Hermes fica fora desta tarefa (v1.x). NÃO FAZER: instalar ou configurar CLIs silenciosamente; portar módulos inteiros; conceder ferramentas além do grant.
```

### P36 — Acesso móvel interino (fase 7, P)
```
Configure acesso interno à PWA a partir do celular sem expor o Harness: Harness em 127.0.0.1; à frente, Tailscale com identidade e ACL (preferência) ou Cloudflare Access ou Caddy com TLS em rede privada. Documente como remover quando o trust plane (P29) estiver ativo. Registre na capability matrix: "EXPERIMENTAL — acesso móvel interno por proxy autenticado. Uso público somente após Identity, Tenant, RBAC e sessão revogável." NÃO FAZER: host 0.0.0.0; Basic Auth como única proteção; armazenar segredos no celular.
```

### P37 — Inventário de licenças, marcas e origem (fase 0, P)
```
Para os sete projetos, registre URL do repositório, commit/tag exato, SHA-256 do snapshot, licença raiz e licenças por diretório. Caveman: liste arquivo a arquivo o que é MIT (skills/, packages/agent/) e o que é BSL-1.1; confirme o Additional Use Grant e a marca pendente. 9Router: registre o subsistema MITM (src/mitm) como componente proibido. Adorable: registre dependência Freestyle. Produza license-inventory.md, trademark-notes.md (DeepSeek, Hermes, OmniRoute, Caveman — uso nominativo) e o gate de release "nenhum Caveman-BSL nem MITM no artefato". NÃO FAZER: presumir que hash de arquivo equivale a commit; incorporar código antes do inventário.
```

### P38 — Windows release gate (fase 9, M)
```
No Windows 11 nativo (x64 e arm64 quando disponível), execute: instalação limpa, upgrade N-1, sandbox (esperado enforcement partial sem WSL2 — verificar que a UI informa e recomenda WSL2/contêiner), filesystem (paths longos, Unicode, symlink, permissões), PowerShell, Prompt-to-App completo, preview, recuperação após crash, atualização e desinstalação sem perda. Registre PASS/FAIL/BLOCKED/NOT SUPPORTED por item com evidência. NÃO FAZER: generalizar resultado de Linux; ocultar itens parciais como completos.
```

Prompts do v1.0 mantidos sem alteração: P00 (com bloco v2.0), P01, P03, P11, P14, P15, P16, P19, P20, P21, P22, P23, P24, P25, P26, P27, P28. Retirados: P02 (contratos duplicados), P04/P05/P06 (substituídos por PoC-03 + plugin de saúde), P07/P08/P09 (→ P35), P10 (sandbox já existe; resta tradução para UI), P12/P13 (→ P33), P17/P18 (→ P34).

---

## Apêndice B — Capability matrix inicial (modelo)

| Capacidade | Linux | macOS | Windows nativo | Windows+WSL2 | Servidor | Celular |
|---|---|---|---|---|---|---|
| Sandbox de execução | ESTÁVEL (full) | ESTÁVEL (full) | BETA (partial) | ESTÁVEL (full) | ESTÁVEL (contêiner) | NÃO SUPORTADO |
| Modelos: DeepSeek direto / OmniRoute | ESTÁVEL após PoC-03 | idem | idem | idem | idem | via servidor |
| Agentes: Codex / Claude Code | ESTÁVEL | ESTÁVEL | BETA | ESTÁVEL | ESTÁVEL | via servidor |
| Hermes | v1.x | v1.x | v1.x | v1.x | v1.x | — |
| 9Router | EXTERNO | EXTERNO | EXTERNO | EXTERNO | EXTERNO | — |
| Prompt-to-App Next.js | alvo ESTÁVEL | alvo ESTÁVEL | Windows release gate | alvo ESTÁVEL | alvo ESTÁVEL | controle |
| Preview privado / Staging | alvo ESTÁVEL | idem | gate | idem | idem | acompanhar |
| Acesso móvel | — | — | — | — | EXPERIMENTAL (proxy) → ESTÁVEL após D18 | BETA |
| Produção | DESLIGADO (v1.0) | | | | | |
| Caveman-BSL / MITM | FORA | | | | | |

---

## Conclusão

O produto é viável como **composição sobre o DeepSeek Harness**, não como fusão
de sete repositórios. Com a E4, a ordem crítica é: inventário e baseline
(Git/WSL2) → PoCs → **trust plane** → composição de modelos/agentes e Postgres →
Prompt-to-App com golden set → preview/staging → PWA → Integration Hub →
qualidade multiplataforma e gate Windows → teste com cinco pessoas leigas →
piloto. Todo estado continua exigindo evidência; nenhuma capacidade é declarada
completa por existir em ZIP, mock ou flag.
