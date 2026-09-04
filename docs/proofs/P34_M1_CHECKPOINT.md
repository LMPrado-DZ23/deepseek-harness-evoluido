# P34/M1 — checkpoint verificável da prévia segura

Data: 04/09/2026. Branch: `codex/missao-m1-preview`. Base imutável:
`ec92f29f7398d1ac69dc6201e5fb8e6bccfa60b9`. Harness upstream preservado em
`6c705be1ce6774a000d061da41d1823b03a3d42c`.

## Construído

- artefato executável separado em `.dz23/preview-artifact-v1`, com fonte
  limitada a 20.000 arquivos/160 MiB e arquivo do runtime a 128 MiB, sem links
  para fora do run e fixado por SHA-256;
- supervisor Docker com plano de controle autenticado por socket Unix,
  `network=none` e autoridade exclusiva sobre imagem, rede, mounts e limites;
- runtime não confiável em `NetworkMode=none` e proxy mínimo compartilhando
  somente seu loopback, sem porta publicada, Docker socket, credenciais do
  Studio ou rota de saída;
- contêineres não-root, raiz somente leitura, `cap_drop=ALL`,
  `no-new-privileges`, limites de CPU/memória/PIDs e volume efêmero;
- Caddy como borda única em `studio.dz23.localhost` e
  `p-<id>.dz23.localhost`, sem CA, TLS interno, DNS ou hosts alterados;
- admissão opaca por `postMessage`, ticket fora de URLs, cookie local host-only,
  `HttpOnly` e `SameSite=Strict`, defesa contra cookies duplicados do preview,
  convite de uso único com TTL de 120 segundos, CSRF em cabeçalho derivado da
  sessão, autorização/revogação no servidor e renovação do cookie limitada ao
  TTL vigente após cada heartbeat;
- modo `studio-preview` com código de acesso capturado somente no volume
  efêmero e exposto somente à mesma pessoa/sessão que abriu a prévia;
- shutdown com aborto de RPC/staging, cleanup idempotente, reconciliação,
  readiness, TTL e falha fechada quando qualquer stager, runtime, proxy, socket
  ou volume permanece vivo; supervisor limitado a 512 MiB.

## Provas executadas no checkpoint final

Ambiente canônico: ext4 no WSL2, Node 22, pnpm 11.7.0 e Docker Desktop.

- `pnpm typecheck`: `PASS`;
- build recursivo dos 12 pacotes aplicáveis: `PASS`;
- i18n: `PASS`, 265 chaves pt-BR; o catálogo do preview é estrito e os demais
  plugins foram congelados no checkpoint anterior para a migração da fatia M2;
- gate de domínios tenant-aware: `PASS`;
- Chromium em contêiner sem rede: 3/3 jornadas `PASS`, cobrindo login HTTP local
  real, recusa sem sessão, Ideia → Plano → Criação → Verificação, iframe,
  admissão, código local, cookie duplicado hostil e encerramento sem alegar
  publicação;
- configuração Caddy atual validada offline com o binário fixado que contém o
  módulo de rate limit: `PASS`;
- composição Caddy + supervisor: `docker compose config --quiet` = `PASS`;
- prova física `P34-M1-runtime-proof.json`: `PASS`, artefato
  `557c907f…d433`, runtime `sha256:f6660dc7…73b42` e supervisor/proxy
  `sha256:0de6fc8f…97ff2`; runtime com apenas `lo`, zero rotas externas, DNS,
  internet, metadata, host Docker e Studio bloqueados, HTTP 200, login sem senha
  e cleanup sem sobreviventes;
- suíte global: 659 testes `PASS`, 18 integrações PostgreSQL puladas por ausência
  deliberada do serviço; cobertura 94,24% statements, 90,04% branches, 95,44%
  functions e 97,11% lines; identidade e política em 100%;
- revisão adversarial independente: `GO`, sem incompatibilidade concreta alta,
  média ou baixa; validação focada independente 79/79 `PASS`;
- `git diff --check`: `PASS`.

As integrações PostgreSQL reais continuam sendo responsabilidade do gate
independente do Claude/M3 e não são inferidas aqui.

## Limites da evidência

- o teste Playwright usa supervisor/forward determinísticos; a prova física
  separada usa manager, runtime, proxy, build Next.js e Chromium reais. Não foi
  executada uma única jornada que una Caddy, Harness real e runtime Docker em
  um só processo de prova;
- HTTPS/ACME, domínio público, celular físico, Tailscale e operação prolongada:
  `NOT_EXECUTED`;
- SMTP real e LLM real: `NOT_CONFIGURED`/`NOT_EXECUTED`;
- experiência para pessoas leigas: `NOT_VALIDATED` até a fase 0.5 reposicionada.

## Veredito honesto

M1/P34 entrega preview local seguro em estado `BETA`. A evidência autoriza
`PREVIEW_OK` somente para o protótipo local verificado deste fluxo; não autoriza
“publicado”, “produção”, “aplicação pronta”, acesso móvel ou release público.
O merge na branch principal continua dependendo do parecer independente do
Claude sobre o commit fechado.
