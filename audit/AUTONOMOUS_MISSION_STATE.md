# Estado da missão autônoma — DZ23 STUDIO v1.0

- mission_id: `DZ23-STUDIO-V1-20260904`
- objetivo: concluir o DZ23 STUDIO v1.0 com runtime portátil, geração isolada, gates Windows/Linux, testes com cinco pessoas e pacote open source somente após licença escolhida
- estado: `REVIEW_REQUIRED`
- iteração: 16
- início: 2026-09-04
- último heartbeat: 2026-09-06T10:28:09-03:00
- último progresso real: M71 passou também um turno completo do Agent com provedor determinístico, aprovação `allowed-once`, ferramenta governada e resposta persistida
- tarefa atual: empacotar o pin cumulativo M71 e aguardar revisão independente do Claude, sem merge na principal
- branch: `codex/m71-assistant-session`
- base: `17e79aaab4c1ac54c1b4fc05f780f6485c5941b7`
- upstream: `deepseek-harness@6c705be1ce6774a000d061da41d1823b03a3d42c`
- staging válido: `/home/leandro/dz23-gates/m63-integration-20260906`
- staging inválido preservado: `/home/leandro/dz23-m61-lock-20260904a` (origem calculada incorretamente e sincronização interrompida)

## Checkpoint atual — M71

- `/studio/assistente` cria ou retoma uma sessão real do Harness, sem duplicar o
  chat;
- preset `dz23-assistant` e repositório são derivados pelo servidor;
- login, CSRF, revogação, criação, inspeção, vínculo e retomada foram exercitados
  no runtime real do pin upstream;
- treze ferramentas governadas estão visíveis no Agent da sessão;
- o Agent real processou uma mensagem, chamou `studio_echo` após uma única
  aprovação `allowed-once` e persistiu `STUDIO_ECHO_OK`; o provedor usado foi
  somente `studio-fake/studio-deterministic`;
- o serviço `studioAssistant` foi isolado por sessão no Cordis depois de uma
  falha real de boot revelar o singleton indevido;
- 58 testes críticos e 3 testes de interface passaram; os serviços críticos têm
  100% de cobertura; o pacote staged passou;
- conversas multiusuário continuam `NOT_SUPPORTED` porque o cliente atual do
  Harness não isola lista/histórico por tenant;
- prova com modelo externo real e redirecionamento Chromium continuam
  `NOT_EXECUTED`.
- clone novo em ext4 passou build oficial upstream, build do Studio, typecheck,
  2.027 testes raiz, 56 testes da interface e cobertura global 96,11/93,56/96,61/98,14;
- o gate de i18n encontrou onze mensagens novas em código, todas migradas para
  catálogos antes do fechamento.

## Checkpoint anterior — M6.3

- quatro fatias locais compostas sem tocar na branch principal;
- contrato cliente→builder reduzido a `upload_ref` opaco;
- TAR canônico transmitido por fluxo autenticado e vinculado no servidor a build, escopo, imagem e política;
- rollback e settlement endurecidos contra falhas simultâneas de journal, Docker e ingresso;
- `648/648` testes do supervisor e cobertura crítica de `100%`;
- suíte integral `1.896 passed`, `61 skipped`, `0 failed`;
- build da interface e dos 14 plugins, portabilidade, i18n e gates de domínio aprovados;
- relatório detalhado em `audit/M63_INTEGRATION_CHECKPOINT.md`.

## Bloqueadores atuais

- Docker continua desligado; provas físicas de imagem, rede e execução são `NOT_EXECUTED`;
- gate completo de origem requer um remoto `origin`, que não existe neste repositório local;
- licença open source exata ainda depende do Prado; sem ela não há redistribuição pública;
- cinco sessões leigas, piloto e release continuam pendentes.

## Próxima ação

1. gerar bundle, arquivo-fonte e relatório P37 do pin cumulativo M71;
2. aguardar e tratar a revisão independente do Claude sem merge;
3. tratar os artefatos `plugins/*/lib/**` rastreados em commit separado, somente
   com autorização explícita;
4. repetir o preflight somente leitura quando Docker e pins estiverem disponíveis;
5. executar as provas físicas somente após autorização para ligar o Docker.

## Histórico preservado — iteração 7 / M6.1

### Concluído naquela iteração

- workspace unificado sem links absolutos e lock regenerado no ext4;
- manifesto independente de Git validando 8.953 blobs, 11 symlinks e modos do upstream;
- profile de produção sem provider falso e materialização gravável versionada no `DSH_HOME`;
- UI e template Next.js empacotados no lifecycle do próprio pacote;
- usuário 10001 real, `HOME` e diretórios persistentes explícitos;
- pnpm baixado e conferido por SHA-512, SHA-256 e SHA-1;
- `pnpm install`, builds e deploy posteriores ao fetch com rede desativada;
- builder com seleção amd64/arm64 e hashes fixados;
- gate de portabilidade cobrindo arquivos não rastreados e entrypoints;
- gate de proveniência/SBOM determinístico: 6/6 testes;
- gate de imagens: 2/2 testes; portabilidade e `git diff --check`: PASS.

### Auditorias delegadas naquela iteração

- runtime: NO-GO inicial; achados incorporados no worktree e aguardando prova física;
- supply chain: NO-GO inicial; pnpm, rede, contexto secreto, licença falsa e manifesto corrigidos; SBOM/proveniência aguardam imagem OCI real;
- builder multiarch: desenho M6.2 definido; não montar Docker socket no Harness.

### Bloqueadores registrados naquela iteração

- imagem runtime ainda não construída após as correções;
- `builder-supervisor` M6.2 ainda não implementado; geração no runtime final deve permanecer `BLOCKED_EXTERNAL` até ele existir;
- prova OCI amd64/arm64, SBOM real, inspect e smoke ainda pendentes;
- licença open source exata ainda depende do Prado; sem ela não há redistribuição pública;
- gate Windows, cinco sessões leigas e piloto continuam pendentes.

### Falhas observadas naquela iteração

- build anterior: `@deepseek-ai/dsh-subprocess-local` não estava na allowlist de scripts; corrigido, reteste pendente;
- build `15e80ec`: a instalação fisicamente sem rede tentou revalidar metadata/attestations e entrou em retries; interrompida e corrigida com `--trust-lockfile` pós-fetch, mantendo `--network=none`;
- primeira sincronização WSL resolveu a origem incorretamente e começou a copiar `/` para staging; foi interrompida, não tocou no repositório, e um staging novo explícito foi criado;
- sincronização seguinte excluiu diretórios aninhados chamados `runtime`; o upstream ficou incompleto; a subárvore foi ressincronizada sem esse padrão e o manifesto passou.

### Próxima ação registrada naquela iteração

1. criar commit local de checkpoint da M6.1;
2. construir a imagem no staging ext4 com o hash exato;
3. corrigir causa raiz de qualquer falha e repetir;
4. provar deploy, profile, UI, template, usuário, Git, readonly/caps/NNP, reinício e sinais;
5. implementar M6.2 builder-supervisor e só então fechar a jornada Prompt-to-App instalada.

## Resume instructions

Leia este arquivo e `audit/M63_INTEGRATION_CHECKPOINT.md`; confira `git status`, `git log -5`, a branch principal separada e o conteúdo de `HANDOFF_CODEX_CLAUDE.md`. Preserve todos os worktrees e stagings. Não faça merge, push, PR, deploy público, limpeza Docker nem escolha licença em nome do Prado.
