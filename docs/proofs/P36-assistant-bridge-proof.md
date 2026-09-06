# P36 — Ponte segura entre o DZ23 STUDIO e conversa/agentes

Estado: **BETA**, árvore não commitada na branch isolada
`codex/p36-studio-assistant-bridge`, baseada em `17e79aa`.

## O que existe

- `/studio/assistente` apresenta uma entrada simples para o chat já existente do
  Harness. Não há cópia do chat e não existe API inventada para criar sessão.
- O preset mínimo `dz23-assistant` expõe somente seis ferramentas tipadas:
  iniciar T2, iniciar sensível T3, listar, revisar, cancelar e aplicar.
- Tanto o início T2 quanto o início sensível T3 aceitam somente
  `spawn-in-process`. Codex e Claude Code continuam disponíveis no seam global
  da fase 3, mas estão `NOT_CONFIGURED` nesta ponte: configuração
  administrativa com qualquer um deles falha no boot, os schemas não os
  anunciam e uma chamada direta do serviço também falha antes de alcançar o
  `StudioAgentService`.
- Organização, tenant, workspace, usuário e papel vêm da sessão do servidor.
  Nenhum desses campos existe nos argumentos que o modelo pode enviar.
- A configuração administrativa valida repositório Git canônico, escopo,
  provedores, caminhos e orçamentos. Caminho pai de uma allowlist é recusado.
- Runs lidos do domínio compartilhado só aparecem, podem ser revisados,
  cancelados ou aplicados se forem `spawn-in-process`, apontarem para o mesmo
  repositório canônico configurado e todos os arquivos alterados estiverem na
  allowlist administrativa. Runs externos da fase 3 ou de outro repositório e
  caminho ficam invisíveis e falham antes do `StudioAgentService`.
- A fronteira administrativa recusa `.git` simbólico. Aceita diretório Git
  normal somente com `HEAD`, `objects` e `refs` tipados e sem symlink (e
  `config`/`config.worktree`/`index` regulares quando presentes). O descritor de
  worktree precisa apontar para um filho direto de `<common>/worktrees`, com
  vínculo recíproco.
- O gerenciador de worktrees revalida top-level, git-dir, common-dir, revisão e
  vínculo recíproco antes de todo diff. O diff usa índice temporário explícito,
  nunca o índice real do worktree ou do projeto principal, e sempre remove o
  índice temporário.
- Subprocessos Git recebem uma allowlist mínima de ambiente, sem chaves de IA,
  proxies, credenciais ou configuração Git herdada. Hooks, fsmonitor, external
  diff, textconv e filtros clean/smudge/process são neutralizados; nomes de
  driver fora da allowlist ou mais de 128 drivers falham fechados. Filtros
  ativados apenas por `includeIf` no git-dir do linked worktree são reavaliados
  no binding exato antes de materializar arquivos.
- Toda delegação usa `StudioAgentService`: worktree, diff verificado, limites,
  auditoria e aprovação existentes são preservados. Aplicar é uma segunda ação
  T2; a ferramenta T3 continua dependendo de identidade forte na policy.
- Filhos/subagentes e presets comuns não podem chamar a ponte. Isso impede
  delegação recursiva usando a identidade herdada.
- Esquemas têm `additionalProperties: false` e o mesmo contrato é imposto de
  novo em runtime, inclusive recusando uma raiz que não seja objeto. Campos
  como `org_id`, `approval` e `repositoryPath` falham.
- O antigo helper lexical `assertInsideWorktree` e o equivalente não usado
  `isCanonicalChild` foram removidos. Eles não seguiam symlink/junction e não
  constituíam uma fronteira de segurança. Uma junction reproduzida dentro de
  um caminho aparentemente permitido não torna provider externo alcançável.

## Provas executadas sem Docker, rede ou instalação

- assistant-bridge: 58/58 testes no freeze fail-closed.
- agents + assistant-bridge: 97/97 testes serializados no freeze fail-closed;
  gerenciador Git: 13/13 no Windows. As provas incluem troca adversarial de
  `.git` sem mudar um byte do índice/status principal, extensões Git hostis,
  filtro ativado somente por `includeIf` no linked worktree, allowlist/teto de
  drivers, remoção de segredos/proxies do ambiente do subprocesso e uso de um
  repositório autorizado que já é um linked worktree real, além da recusa do
  vínculo recíproco ausente ou apontando para outro `.git`.
- launcher React: o 1/1 do freeze anterior continua registrado, mas a repetição
  atual ficou `BLOCKED_ENVIRONMENT` antes de coletar testes porque
  `lucide-react` não existe na instalação parcial local.
- cobertura do freeze anterior: 98,89% statements, 99,08% branches, 95,83%
  functions e 98,64% lines; `catalog.ts`, `closed-tool.ts` e `service.ts` tinham
  100% em todas as métricas. A repetição após o fail-closed ficou
  `BLOCKED_ENVIRONMENT` na conversão V8 (`ast-v8-to-istanbul: d is not a
  function`), depois dos testes, portanto esses percentuais não são
  reapresentados como medição do freeze atual.
- builds isolados de agents e assistant-bridge: PASS.
- pacote isolado: `pnpm pack --dry-run` lista 23 arquivos e inclui
  `i18n/pt-BR.json`, `lib/i18n.js`, `lib/index.js` e `package.json`; o `lib`
  staged carregou e traduziu uma chave usando somente o catálogo empacotado.
- prova Node pura do freeze anterior resolveu `@dz23-studio/agents` pelo export do pacote
  (`lib/index.js`), não pelo alias de testes, e confirmou que filtros normais e
  condicionais não executam e que nome inseguro de driver é bloqueado antes de
  criar worktree. Uma segunda carga usou cópia staged contendo somente
  `lib`/`i18n` e repetiu a prova. O manifesto de agents inclui explicitamente
  `lib`, `i18n` e `src`; o comando canônico `prove:assistant-package` agora
  compila agents e assistant-bridge antes da prova, portanto um clone limpo não
  depende de artefato oculto pré-existente. Para o freeze fail-closed, os dois
  `lib` foram regenerados e o catálogo compilado confirmou somente
  `spawn-in-process`; a prova completa de pacote ficou `BLOCKED_ENVIRONMENT`
  ao importar a identidade porque `tsyringe` não existe na instalação local.
- o profile e seu lockfile declaram a ponte; a raiz de presets é explícita no
  Compose local e de servidor; uma resolução offline a partir de um profile
  staged carregou o módulo real `dz23-studio-assistant-bridge`.
- build do Studio Web: TypeScript + Vite web + service worker: PASS.
- `I18N_GATE=PASS`: 10 catálogos, 287 chaves, baseline sem crescimento.
- `ASSISTANT_TOOL_CATALOG=PASS`: seis ferramentas, provider exclusivo
  `spawn-in-process` e mutações negativas de remoção, valor da regra e
  `source`.
- o contrato TypeScript da ponte aceita `spawn-in-process` e contém
  `@ts-expect-error` verificado para Codex e Claude Code; compilação focada:
  PASS. O `lib/service.d.ts` emitido usa `AssistantProvider`, não a união global.
- P37 no worktree: PASS, 11.519 arquivos, 371 manifests, 50 licenças, zero
  achado. A contagem está contaminada por módulos ignorados da instalação
  parcial e não representa o artefato final; o release gate deve rodar no
  artefato limpo/staged.

## Limites honestos

- Criar automaticamente uma sessão dedicada pelo botão: `NOT_PRESENT`. O
  launcher abre somente a rota pública e estável do chat do Harness.
- Codex CLI e Claude Code reais pela ponte: `NOT_CONFIGURED`; o E2E de
  confinamento em Windows e Linux continua `NOT_EXECUTED`. O provider
  in-process é o único habilitado; Hermes: `NOT_PRESENT`.
- Cancelamento sobrevive somente no mesmo processo: `BETA`, fail-closed depois
  de restart. Jobs concluídos são removidos do mapa para não vazar memória.
- MCP, skills, memória semântica e uma interface visual de equipe de agentes:
  `NOT_PRESENT` neste preset mínimo.
- Equipe multiagente/DAG estilo Hermes: `NOT_PRESENT`. Cada chamada inicia uma
  única execução; não há consenso, dependências entre tarefas nem síntese de
  vários agentes.
- Não houve Docker, rede, browser E2E, commit, merge, push ou deploy.
- `safeTextFile()` ainda faz `lstat` seguido de leitura pelo pathname. A janela
  TOCTOU foi registrada como defesa em profundidade de baixa prioridade; não
  se tentou um `O_NOFOLLOW` sem prova portátil em Windows e Linux. Providers
  externos permanecem fail-closed, e o provider in-process não recebe shell,
  processo em segundo plano nem ferramenta interativa.
- `dump-config` real no WSL2 está `BLOCKED_ENVIRONMENT`: o CLI upstream fixado
  falha antes de ler o Studio com `SyntaxError: ./lib/argument.js does not
  provide an export named Argument` na instalação local de `commander`. Nenhuma
  dependência foi reparada ou hidratada. Portanto o carregamento ponta a ponta
  do preset no Harness permanece `NOT_EXECUTED`.
- O typecheck de raiz não foi usado como evidência: os links locais atuais não
  contêm várias dependências já declaradas (por exemplo `pg`, `sharp`,
  `typescript` e plugins do próprio workspace). Os plugins agents e
  assistant-bridge foram compilados separadamente com o compilador já presente,
  sem instalar ou hidratar pacotes. A repetição atual de `pnpm pack --dry-run`
  também ficou `BLOCKED_ENVIRONMENT` porque o workspace dependency
  `@dz23-studio/agents` não está instalado; a prova staged/Node acima passou.
