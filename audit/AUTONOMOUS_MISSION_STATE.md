# Estado da missão autônoma — DZ23 STUDIO v1.0

- mission_id: `DZ23-STUDIO-V1-20260904`
- objetivo: concluir o DZ23 STUDIO v1.0 com runtime portátil, geração isolada, gates Windows/Linux, testes com cinco pessoas e pacote open source somente após licença escolhida
- estado: `INTEGRATING_AND_PROVING`
- iteração: 21
- início: 2026-09-04
- último heartbeat: 2026-09-06T22:53:20-03:00
- último progresso real: M81 provou a saída em Chromium, fechou cookie obsoleto e modo pessoal e concluiu scan com zero achado
- tarefa atual: documentar e empacotar a ponta M81 para revisão independente do Claude, sem merge na principal
- branch: `codex/m81-signout-browser-e2e`
- ponta funcional: `ac4860e`
- base: `3da1aa92d6d72f0aa59e0b6eccc80e609b36e23f`
- upstream: `deepseek-harness@6c705be1ce6774a000d061da41d1823b03a3d42c`
- staging válido: `/home/leandro/dz23-gates/m63-integration-20260906`
- staging inválido preservado: `/home/leandro/dz23-m61-lock-20260904a` (origem calculada incorretamente e sincronização interrompida)

## Checkpoint preservado — M79

- bootstrap prova origem, gitlink, commit, tree, limpeza e manifesto antes de
  converter placeholders de symlink;
- materialização de symlink é transacional e preserva/restaura o placeholder
  quando o Windows recusa a operação;
- `core.worktree` só migra para configuração local sob invariantes estritos e
  sem ativar configuração ou extensão preexistente;
- falha real no Windows sem Modo de Desenvolvedor preservou blob e limpeza;
- clone novo WSL2/ext4 passou bootstrap, builds, typecheck, gates estáticos e
  2.027 testes raiz, com zero falha;
- Security Diff Scan `0d486eee-a292-4b2b-8cfd-e8ce91897824`: cobertura
  completa, zero achado;
- Docker e PostgreSQL físico não foram usados; lifecycle real continua
  `NOT_EXECUTED`.

## Checkpoint mais recente — M80

- saída exige sessão autenticada, origem permitida e CSRF válido;
- o servidor revoga exatamente a sessão corrente e só então expira cookies e
  confirma `signed_out: true`;
- o navegador só após essa prova apaga caches e chaves DZ23 e segue para
  `/login`; falha do servidor não finge sucesso;
- identidade HTTP 16/16, recorte de saída/PWA 8/8 e app completo 60/60 passaram;
- clone limpo WSL2/ext4 passou bootstrap, builds, typecheck e gates estáticos;
- suíte raiz ficou conhecida, não verde: um timeout não relacionado da
  builder-supervisor persistiu sob carga e o arquivo passou 52/52 isolado;
- Security Diff Scan `377b88f6-552e-446a-9f4e-cd7687c59385`: 8/8 superfícies,
  cobertura completa e zero achado;
- Docker, PostgreSQL físico, navegador E2E e celular continuam `NOT_EXECUTED`.

## Checkpoint mais recente — M81

- logout de cookie ausente, expirado ou revogado agora termina a limpeza sem
  fingir uma nova revogação;
- qualquer candidato de sessão ativo continua exigindo o próprio CSRF e só
  revoga a sessão corrente; 65 candidatos distintos são recusados;
- o Caddy libera somente o caminho exato de logout do `forward_auth`; segredo
  da borda, Host, Origin e contrato de método permanecem no handler;
- a interface só oferece **Sair** após `mode: authenticated`; modo pessoal e
  falha de descoberta ficam fechados;
- a autorização de prévia foi provada como inválida logo após revogação da
  sessão de origem ou perda de membership;
- Chromium 3/3, aplicativo 63/63, identidade+prévia 76/76, identidade final
  20/20 e cobertura do handler 100% passaram;
- build oficial upstream, build do Studio, typecheck e gates estáticos passaram
  no clone WSL2/ext4;
- Security Diff Scan `781b183b-a00b-4c09-9e76-2be9a266b84e`: dez superfícies,
  zero achado reportável;
- Caddy/Docker real e celular físico continuam `NOT_EXECUTED`.

## Checkpoint preservado — M71

- `/studio/assistente` cria ou retoma uma sessão real do Harness, sem duplicar o
  chat;
- preset `dz23-assistant` e repositório são derivados pelo servidor;
- login, CSRF, revogação, criação, inspeção, vínculo e retomada foram exercitados
  no runtime real do pin upstream;
- treze ferramentas governadas estão visíveis no Agent da sessão;
- o Agent real processou uma mensagem, chamou `studio_echo` após uma única
  aprovação `allowed-once` e persistiu `STUDIO_ECHO_OK`; o provedor usado foi
  somente `studio-fake/studio-deterministic`;
- Microsoft Edge real abriu a entrada do Assistente, selecionou o mesmo
  `session_id` no contrato do Harness e terminou no chat oficial;
- Ollama real respondeu por `qwen2.5:0.5b` através somente da interface virtual
  WSL do Hyper-V; nenhuma rota externa, bind público ou mudança de firewall;
- o serviço `studioAssistant` foi isolado por sessão no Cordis depois de uma
  falha real de boot revelar o singleton indevido;
- 58 testes críticos e 3 testes de interface passaram; os serviços críticos têm
  100% de cobertura; o pacote staged passou;
- conversas multiusuário continuam `NOT_SUPPORTED` porque o cliente atual do
  Harness não isola lista/histórico por tenant;
- prova com modelo externo, navegador móvel e interação humana continuam
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

1. gerar bundle, arquivos-fonte e relatório P37 do pin cumulativo M81;
2. pedir e tratar a revisão independente do Claude sem merge;
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
