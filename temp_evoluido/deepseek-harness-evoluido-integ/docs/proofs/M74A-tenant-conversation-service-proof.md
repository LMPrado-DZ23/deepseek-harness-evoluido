# M74-A — Serviço interno de conversa tenant-aware

Estado: **GO para a fundação interna isolada**. A capacidade visível de conversa
multiusuário continua `NOT_SUPPORTED` porque HTTP/SSE e interface ainda não
existem. Base M73 `dcae68bf80d3f1f4ecee4b97782d60d9bc9467f5`;
implementação de código em `1f5f937`. Nenhum merge na principal, push, PR,
deploy ou uso de Docker foi realizado.

Hardening de autorização em `251ffd1`: a revisão adversarial confirmou que
o `viewer` podia criar, enviar e cancelar usando apenas `project.read`. O serviço
e o launcher agora exigem `project.write` antes de qualquer uma dessas ações;
o histórico próprio permanece legível com `project.read`.

## Problema

O bloqueio da M73 eliminou a exposição cruzada, mas deixou o modo equipe sem
conversa. A alternativa segura precisava reutilizar o motor real do Harness sem
reabrir sua API, RPC, WebSocket ou diário bruto.

## Implementação

- `StudioIdentityService` tornou o vínculo de sessão do Harness exclusivo,
  serializa bind, revogação, autenticação e step-up e falha fechado quando o
  armazenamento contém zero ou mais de um proprietário;
- `ownsHarnessSession` exige a mesma sessão de identidade ativa, pessoa,
  organização e tenant;
- `launchTenantConversation` cria a sessão interna governada sem abrir o cliente
  oficial, que continua pessoal-only;
- `AssistantConversationService` autoriza toda chamada: `snapshot` exige
  `project.read`, enquanto `open`, `send` e `cancel` exigem `project.write`; um
  `viewer` consegue ler o próprio histórico, mas nunca criar custo ou trabalho;
  mensagens aceitas continuam somente texto de até 32 KiB;
- o sanitizador usa allowlist de seis tipos públicos e elimina headers, `cwd`,
  configuração, raciocínio, argumentos/resultados de ferramentas, contexto de
  plugins, replay interno e eventos desconhecidos;
- a resposta limita a 500 eventos e 64 KiB por texto, rotula ferramentas com
  linguagem comum e converte falhas internas em erros públicos genéricos;
- os textos novos foram movidos para catálogos pt-BR versionados depois que o
  gate de i18n recusou a primeira candidata.

Não existe registro em `apply()`, rota HTTP, SSE ou componente visual nesta
fatia. Assim, a barreira da M73 não foi afrouxada.

## Provas em WSL2/ext4

Staging: `/home/leandro/dz23-gates/m74-clean-e9166dc`. Upstream fixado em
`6c705be1ce6774a000d061da41d1823b03a3d42c`, 8.953 entradas e manifesto
SHA-256 `862b92782c2f5cd67f81debd1116b16150dfafd84fb4ce2602a729f9cf3d26dc`.

- instalação offline e lock congelado: PASS;
- typecheck: PASS;
- build da interface e de 16 plugins: PASS;
- suíte integral com um worker: **2.042 PASS / 62 SKIP / 0 FAIL** antes da
  correção de i18n;
- suíte integral com cobertura depois da correção: **2.043 PASS / 62 SKIP /
  0 FAIL**;
- cobertura global: 96,15% statements, 93,65% branches, 96,65% functions e
  98,17% lines;
- `plugins/identity/src/**`: **100%** nas quatro métricas;
- `assistant-session.ts` e `assistant-conversation.ts`: **100%** nas quatro
  métricas;
- regressão de permissão após `251ffd1`: **15/15** testes focados e 100% nas
  quatro métricas dos dois serviços;
- validação cumulativa pós-hardening: typecheck, build da interface e dos 16
  plugins, i18n, escopos, 24 rotas de domínio, catálogo de 13 ferramentas,
  portabilidade e pin upstream: PASS;
- i18n: PASS, 13 catálogos, 287 chaves, sem crescimento do legado;
- escopos, 24 rotas de domínio, catálogo de 13 ferramentas, portabilidade e pin
  upstream com cinco fixtures negativas: PASS.

O primeiro passe integral teve um timeout de 5 s no teste de descritores sob
paralelismo. A cobertura paralela também excedeu 5 s em duas provas de 20 mil
entradas e expôs uma corrida de teste de socket. Cada uma passou 3/3 isolada; a
suíte completa e a cobertura passaram com um worker antes do hardening.

Após `251ffd1`, a rodada cumulativa com cobertura e um worker registrou **2.041
PASS / 62 SKIP / 3 timeouts**: duas provas TAR de 20 mil entradas e o inventário
de escopos excederam seus limites de 5 s/15 s sob a carga total. Os dois arquivos
foram reexecutados isoladamente logo depois e fecharam **20/20 PASS** em 16,13 s;
os três casos que haviam expirado terminaram em 1,50 s, 2,68 s e 1,71 s. Como a
rodada falhou, ela não é declarada verde nem usada para publicar nova cobertura
global. A prova focada da mudança permanece 15/15 e 100% nos dois serviços.
Classificação: contenção de I/O/CPU, classe (d), sem falha lógica reproduzível e
sem alteração nos pacotes envolvidos.

O `build:official` do upstream encontrou a limitação já conhecida do postinstall
em worktree Git vinculado. Foram reutilizadas apenas as saídas `lib/**` do
staging M73 já provado; nenhuma saída foi sincronizada para a branch de fonte.

## Limites honestos

- HTTP, SSE, aprovação e interface: `NOT_PRESENT`;
- navegador, celular físico, modelo externo e duas pessoas reais: `NOT_EXECUTED`;
- a exclusividade usa mutex em processo único; multi-instância depende de
  transação/índice único no PostgreSQL;
- RLS permanece responsabilidade da M72 e não foi simulada nesta fatia;
- o diário bruto ainda é lido apenas internamente antes da projeção; M74-B deve
  adotar paginação/follow limitado para streaming e nunca devolver o objeto cru.

O resultado prova um serviço interno seguro o bastante para revisão da M74-B;
não prova uma experiência de chat multiusuário pronta.
