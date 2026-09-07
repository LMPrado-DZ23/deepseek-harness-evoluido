# Estado da missão autônoma — DZ23 STUDIO v1.0

- mission_id: `DZ23-STUDIO-V1-20260904`
- objetivo: concluir o DZ23 STUDIO v1.0 com runtime portátil, geração isolada, gates Windows/Linux, testes com cinco pessoas e pacote open source somente após licença escolhida
- estado: `CHECKPOINTING`
- iteração: 29
- início: 2026-09-04
- último heartbeat: 2026-09-07T07:21:00-03:00
- último progresso real: M89 passou integralmente em clone limpo WSL2/ext4, com 2.066 testes aprovados, 62 pulados e zero falha
- tarefa atual: consolidar a evidência limpa da M89 e aguardar revisão independente do Claude, sem merge na principal
- branch: `codex/m89-immutable-staging`
- ponta funcional: `2093dc0a524bc03671c3c0e35406cd84dd2f3c42`
- base: `2f2a772d98d916514652e0f7797f00339c9a3877`
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

## Iteração M86 — transporte HTTP bruto do limite de Cookie

- estado: `CHECKPOINTING`;
- branch: `codex/m86-raw-cookie-transport`;
- base: `codex/m84-image-self-verification@b74bf6ea82d2549a545d706540dfebfc6116ccae`;
- commit funcional: `1788d036a878080c4a10ee2b2718ce328e1deef5`;
- objetivo: fechar o limite residual explicitamente `NOT_EXECUTED` da M83 com
  duas linhas `Cookie` reais sobre socket TCP, após a normalização do
  `node:http`;
- alteração funcional: apenas
  `plugins/identity/tests/http-raw-cookie.spec.ts`; nenhuma linha de produção
  foi alterada;
- exatamente 8.192 bytes normalizados: aceito, logout autenticado, CSRF e
  revogação executados;
- exatamente 8.193 bytes normalizados: `431 COOKIE_HEADER_TOO_LARGE`, sem
  consulta ao segredo de borda, autenticação, CSRF, revogação ou `Set-Cookie`;
- o servidor da prova usa `maxHeaderSize: 32 KiB`, impedindo falso positivo do
  parser HTTP do próprio Node;
- teste focado: 2/2 `PASS`;
- regressão do plugin Identity: 58/58 `PASS` em seis arquivos;
- compilador TypeScript chamado diretamente: `PASS`; o script canônico
  `pnpm typecheck` ficou `BLOCKED_ENVIRONMENT` antes do compilador porque o
  `postinstall` do submódulo recusou a configuração Git compartilhada do
  worktree;
- revisão independente somente leitura: nenhum bypass estático; recomendação
  de socket bruto, captura do cabeçalho normalizado e aumento do parser
  incorporada;
- P37 self-test positivo/negativo/vazio: `PASS`; fonte funcional: 866 arquivos,
  22 manifests, uma licença, zero achado;
- principal `codex/p30-policy-foundation@17e79aa` preservada;
- nenhum merge, push, PR, deploy, Docker, exclusão ou limpeza executado;
- próxima ação: gerar evidência final e solicitar revisão somente leitura do
  Claude depois das prioridades M72/M73/M74-A/M75/M83/M84 já registradas.

## Iteração M87 — contrato reproduzível de clone limpo

- estado: `CHECKPOINTING`;
- branch: `codex/m87-clean-clone-contract`;
- base: `codex/m86-raw-cookie-transport@36de4543d98cde06fcd0e7aeee0b338d14fc713d`;
- commit funcional: `ee036df2311d14afa08007d90c141d6963864822`;
- objetivo: transformar o bootstrap realmente comprovado em contrato executável
  do README e impedir a volta do comando de teste incorreto;
- alteração funcional: nenhuma linha de produção foi alterada; o README usa
  `pnpm exec vitest run --maxWorkers=1`, e
  `tests/portability/clean-clone-readme.test.mjs` fixa a sequência canônica de
  oito comandos;
- workflow Windows executa o novo contrato hermético;
- contrato hermético no Windows: 31/31 `PASS`;
- clone descartável real no ext4 do WSL2:
  `/home/leandro/dz23-gates/m87-clean-clone-36de454`;
- upstream materializado no commit fixado `6c705be`, manifesto de 8.953 entradas
  validado com SHA-256
  `862b92782c2f5cd67f81debd1116b16150dfafd84fb4ce2602a729f9cf3d26dc`;
- instalação congelada e `build:official` do Harness: `PASS`;
- instalação congelada filtrada, build do Studio e `pnpm typecheck`: `PASS`;
- suíte canônica no clone limpo: 126 arquivos aprovados, seis pulados; 2.036
  testes aprovados, 62 pulados e zero falha;
- depois do build, 51 mudanças rastreadas apareceram, todas em
  `plugins/*/lib/**`; nenhuma mudança fora dessa árvore e submódulo limpo;
- conclusão limitada: o grafo de tipos e o bootstrap limpo estão comprovados;
  o resíduo de artefatos `lib` rastreados continua separado e não será removido
  sem autorização do Prado;
- imagem Docker/OCI real, Postgres físico, CI remoto, Windows instalado,
  cinco sessões leigas e piloto continuam `NOT_EXECUTED` nesta iteração;
- principal `codex/p30-policy-foundation@17e79aa` preservada;
- nenhum merge, push, PR, deploy, Docker, exclusão, limpeza ou alteração de
  `plugins/*/lib/**` foi executado.

## Iteração M88 — cobertura completa dos contratos Windows

- estado: `CHECKPOINTING`;
- branch: `codex/m88-windows-contract-coverage`;
- base: M87 `0eed123a2c2d92ba85de122a843ac41fbda950c5`;
- commit funcional: `9590ce40e1e440721aee4bec0ece0d0ea85e65a4`;
- causa raiz: o job Windows declarava “Windows release contracts”, mas executava
  somente um dos seis arquivos `tests/m6/windows-*.test.mjs`;
- `tests/m6/windows-contract-matrix.json` separa contratos hospedáveis dos que
  exigem Windows + Ubuntu/WSL2, e o gate falha se um arquivo novo não for
  classificado exatamente uma vez;
- `scripts/run-windows-contracts.mjs` executa os arquivos serialmente, sem
  shell/eval e sem iniciar Docker; valida PowerShell 7 e, no perfil local, o
  kernel `microsoft-standard-WSL2`;
- cada filho usa relatório TAP; zero testes, resumo/plano duplicado ou
  divergente, falha, cancelamento, pendência ou teste pulado são recusados;
- caminhos externos, `..`, symlink e resolução física fora do checkout são
  recusados antes de executar código;
- o workflow verifica `$LASTEXITCODE` imediatamente, impedindo que uma segunda
  chamada verde esconda a primeira falha;
- perfil `hosted`: três arquivos, sete testes, zero pulado, `PASS`;
- perfil `windows-wsl2`: três arquivos, 16 testes, zero pulado, `PASS`;
- gate de cobertura/adversarial: 4/4 `PASS`;
- bloco hermético complementar do workflow: 34/34 `PASS`;
- revisão independente encontrou e levou ao fechamento de cinco classes de
  bypass: falha nativa mascarada, WSL1 aceito, skip aceito, resumo TAP duplicado
  e caminho por symlink; re-revisão funcional terminou `GO`;
- lifecycle Docker Desktop real, imagem OCI, CI remoto, instalação completa,
  cinco sessões leigas e piloto continuam `NOT_EXECUTED`;
- principal `codex/p30-policy-foundation@17e79aa` preservada;
- nenhum merge, push, PR, deploy, Docker, exclusão, limpeza ou alteração de
  `plugins/*/lib/**` foi executado.

## Iteração M89 — núcleo governado de staging imutável

- estado: `CHECKPOINTING`;
- branch: `codex/m89-immutable-staging`;
- base: M88 `2f2a772d98d916514652e0f7797f00339c9a3877`;
- commit funcional: `2093dc0a524bc03671c3c0e35406cd84dd2f3c42`;
- domínio físico `studio_staging_releases`, nome lógico
  `studio.staging.releases`, adicionado às duas topologias de storage;
- publicação e rollback exigem sessão, `project.publish_staging`, claim T2 de
  uso único e artefato selado; `approved: true`, caminhos do cliente e destino
  de produção não fazem parte do contrato;
- reserva global por destino, geração monotônica, CAS, lease fencing,
  quarentena cercada e ponteiro ativo transacional impedem concorrência e
  roubo de lock por geração atrasada;
- exceção, resposta perdida ou malformada da autoridade T2 mantém
  `APPROVAL_PENDING / APPROVAL_STATUS_UNKNOWN`; somente negação definitiva é
  terminal;
- efeitos externos inconclusivos permanecem `RECONCILIATION_REQUIRED`, e o
  provider só pode responder `READY` ou `UNKNOWN`;
- rollback republica artefato imutável anterior e preserva o histórico;
- 30/30 testes focados passaram; cobertura focada: 91,36% statements, 91,14%
  branches, 97,05% functions e 95,85% lines; modelo, artefato e segurança
  críticos atingiram 100% de linhas;
- typecheck raiz, build oficial do Harness, build real dos pacotes Studio,
  i18n, escopos, rotas de 25 domínios, catálogo, portabilidade e P37 passaram;
- P37 do candidato inspecionou 890 arquivos, 23 manifests e uma licença, com
  zero achado; self-tests positivo, negativo e vazio passaram;
- revisão adversarial independente encontrou e levou ao fechamento de três
  classes: quarentena sem fencing, exceção T2 terminalizada incorretamente e
  estado iniciado sem aprovação; re-revisão terminou `GO — STAGING_CORE_BETA`;
- suíte completa no Windows nativo: 1.740 aprovados, 358 pulados e 29 falhas em
  dez arquivos; nenhuma falha pertence ao novo plugin. As falhas observadas são
  contratos Unix ou limitações já conhecidas do ambiente Windows (symlink,
  FIFO, socket Unix, sparse files, sinal POSIX e OpenSSL ausente);
- repetição integral em clone limpo WSL2/ext4, destacado em
  `c2bc3a9dd75ab6f50d3baa95746b54e4fc1602f9`: bootstrap do upstream, pin,
  install congelado, build oficial, build Studio, typecheck e suíte completa
  passaram; **129 arquivos e 2.066 testes aprovados, 6 arquivos e 62 testes
  pulados, zero falha**;
- a compilação do clone alterou somente artefatos rastreados sob
  `plugins/*/lib/**`; o submódulo Harness permaneceu limpo no pin `6c705be1`;
- provider, rota HTTP, montagem no runtime, Docker, rede, credencial e staging
  físico continuam `NOT_CONFIGURED` / `NOT_PRESENT` / `NOT_EXECUTED`;
- principal `codex/p30-policy-foundation@17e79aa` preservada;
- nenhum merge, push, PR, deploy, Docker, exclusão, limpeza ou alteração
  permanente de `plugins/*/lib/**` foi executado;
- próxima ação: gerar o artefato final, selar hashes e solicitar revisão do
  Claude antes de qualquer integração.
