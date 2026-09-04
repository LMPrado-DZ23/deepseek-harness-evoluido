# Matriz de capacidades — DZ23 STUDIO

Estados seguem ADR-005 e nunca transformam uma prova focada em “aplicação
pronta”. E4 acrescenta `NOT_VALIDATED` exclusivamente para experiência humana:
o código pode existir, mas ainda não foi validado com pessoas leigas.

| Capacidade | Estado | Evidência | Falta para ESTÁVEL |
| --- | --- | --- | --- |
| Núcleo composto sem diff no Harness | BETA | PoC-01b | empacotamento e jornadas reais |
| Identidade, sessão revogável e RBAC | BETA | P29-A/P29-B | PostgreSQL multi-instância e UI final |
| Acesso móvel por borda autenticada | BETA | P29-C: HTTP, RPC e WS reais | celular/Tailscale e domínio reais |
| Interface instalável (PWA) e uso sem rede | BETA | M4: manifesto, ícones, service worker só de casca (nunca `/api/`), casca servida com o servidor fora do ar e faixa offline provados em Chromium (`docs/proofs/M4-studio-pwa-proof.md`) | instalação em aparelho físico, preview no celular (M1/HTTPS), fase 0.5 |
| Restauração do armazenamento a partir da cópia de segurança | BETA | P31-B: cópia agendada + cópia do operador com o Studio ligado, esquema destruído, restauração pela CLI, Studio religado com a mesma sessão e registros idênticos, recusa sem confirmação (`docs/proofs/P31-B-backup-restore-proof.md`) | servidor remoto com TLS `verify-full`, Compose, ensaio periódico pelo operador |
| Integration Hub: registro por manifesto assinado com tiers D16 | BETA | M5: Ed25519, piso por natureza, não verificado ≥ T2 e bloqueado no canal estável, `can_enable` do servidor, recusas auditadas; 26 testes + prova no Studio real com Chromium (`docs/proofs/M5-integration-hub-proof.md`) | publicadores reais com chaves publicadas, fase 0.5 |
| E-mail do aplicativo gerado por referência (SMTP) | BETA | M5: só o nome do segredo é guardado; existência e formato conferidos pelo seam de credenciais; teste `NOT_EXECUTED` até liberação | provedor escolhido pelo Prado e envio real (`NOT_EXECUTED`) |
| Pacote do protótipo verificado (download ZIP) | BETA | M5: reproduzível, sem `data/`/`.env`/códigos, SHA-256 conferido byte a byte no download, 200 MB de orçamento | standalone real produzido pelo pipeline (a prova usa run simulada), fase 0.5 |
| Marketplace de integrações | NOT_PRESENT | ADR-031 §8 | plugins assinados e decisão de publicação (ADR-009/ADR-013) |
| Notificação local de fim de criação | NOT_IMPLEMENTED | M4: módulo e teste com evento sintético existem; a interface ainda não dispara o evento nem pede permissão | duas linhas em `App.tsx` na integração (handoff) e prova em Chromium |
| Bind público da porta interna do Harness | BLOCKED | ADR-012 proíbe | não deve ser liberado |
| TLS ACME em domínio real | NOT_EXECUTED | configuração validada | emissão e renovação reais |
| Deploy de produção | NOT_EXECUTED | nenhum deploy | fase própria com aprovação humana |
| Domínios Studio em PostgreSQL | BETA | P31-A + P31-B: 20/20 domínios roteados e provados no esquema; backup lógico a quente agendado; migração json→PostgreSQL de instância real; gate sem pular integrações | Compose executado em servidor real, restauração ensaiada em produção, RLS |
| Escritor único cross-process | BETA | P31-A + P31-B: operação contínua de 30 min com backups a quente, contenda recusada o tempo todo e tomada após `SIGKILL` (`docs/proofs/P31-B-postgres-soak-proof.md`) | observabilidade do lease na interface |
| Multi-instância ativa/standby quente | BLOCKED | ADR-013: estado autoritativo em memória | contrato de fencing/reload upstream |
| RLS PostgreSQL por tenant | NOT_PRESENT | KV armazena JSON opaco | repositório tenant-aware + role sem BYPASSRLS |
| Transação de negócio multi-registro | NOT_PRESENT | contrato KV é atômico por chamada | extensão batch/CAS transacional |
| Migração SQLite lógica | BETA | bundle versionado e E2E focado P31-A | restore operacional e dataset real |
| Experiência para pessoas leigas | NOT_VALIDATED | E4 reposicionou a fase 0.5 após o gate Windows; kit `cdd2edb` preservado como base metodológica | produto completo, preflight adaptado e cinco sessões `VALID` com gate 4/5 |
| Prompt-to-App: landing page e catálogo | BETA | Next.js 16 App Router, build standalone, job assíncrono cancelável, API tenant-aware e critérios AppSpec em contêiner comprovadamente sem rede | LLM real, fase 0.5 e operação prolongada |
| DesignSpec e identidade visual do protótipo | BETA | domínio tenant-aware, seis papéis de cor com contraste AA, fontes locais, tokens protegidos e PNG/JPEG reprocessado | LLM real, preview, fase 0.5 e operação prolongada |
| Banco SQLite do aplicativo gerado | BETA | esquema, migração e repositórios Zod determinísticos; SQLite em arquivo, auth e CRUD reais no contêiner sem rede | operação prolongada e staging |
| Acesso do aplicativo gerado | BETA | owner/member, convite, código ligado ao navegador, limite de emissão, sessão opaca, CSRF e 401→200 exercitados; captura restrita ao verificador protegido | SMTP real, passkey, preview HTTPS e operação prolongada |
| Prompt-to-App: formulário e banco | BETA | três fixtures; envio público comum com lista privada e fluxo sensível inteiramente autenticado | LLM real, preview e fase 0.5 |
| Prompt-to-App: painel CRUD | BETA | três fixtures; login→listar→criar→editar→excluir com confirmação em Playwright | relações entre entidades, LLM real, preview e fase 0.5 |
| Prompt-to-App: agenda interna | BETA | conflito, escopo member-own/owner-all, confirmação pelo proprietário, cancelamento pelo próprio membro e liberação de horário em prova determinística | timezone configurável, preview integrado, operação prolongada e fase 0.5 |
| Prompt-to-App: dashboard | BETA | total, tabela e gráfico derivados do mesmo repositório e comparados com uma linha conhecida | métricas financeiras/atrasos por domínio, LLM real, preview integrado e fase 0.5 |
| Prompt-to-App: área autenticada mínima | BETA | registros com owner derivado da sessão, member-own/owner-all, edição, exclusão confirmada, limites de payload e isolamento 404 sem enumeração | documentos, família/responsável, campos bancários, LLM real, preview integrado e fase 0.5 |
| Passkeys no aplicativo gerado | NOT_PRESENT | código por e-mail é a única cerimônia atual | domínio real e fatia própria |
| Preview autenticado | BETA | P34/M1: artefato por SHA-256, runtime `NetworkMode=none`, proxy somente no loopback compartilhado, host/metadata/egress bloqueados, Caddy validado, cookie-tossing neutralizado, 3/3 jornadas Chromium e cleanup físico sem sobreviventes | jornada única Caddy+Harness+runtime, HTTPS/domínio/celular reais, operação prolongada e fase 0.5 |
| Publicação | NOT_PRESENT | nenhuma rota, estado ou botão de publicação | fase autorizada, staging antes de produção e aprovação humana |
| Rotas DeepSeek/OmniRoute/Ollama no profile | BETA | PoC 3A carregou as três; retry OmniRoute/Ollama = 0 | provedores reais e operação prolongada |
| Saúde, custo e fallback por rota | BETA | falhas determinísticas antes/depois do primeiro conteúdo | telemetria com rotas reais |
| Agente in-process isolado | BETA | PoC 3A real em worktree, diff proposto, nega saída/tool | jornadas do produto e teste com leigos |
| Codex CLI como subagente | NOT_EXECUTED | provider registrado; preflight WSL = NOT_PRESENT | CLI/autenticação explícitas e prova real |
| Claude Code como subagente | NOT_EXECUTED | provider registrado; preflight WSL = OK | variável explícita e prova real em worktree |
| Hermes Agent | NOT_PRESENT | prova 7.6 somente leitura | adapter JSON-RPC v1.x e auditoria de segurança |
