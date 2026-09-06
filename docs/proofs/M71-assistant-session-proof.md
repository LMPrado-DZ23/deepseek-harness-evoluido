# M71 — Sessão real e governada do Assistente

Estado: **BETA pessoal/dispositivo**. Base: M70
`f46853e5f1bdb2237e2e4757536bac65d6e80a65`. Implementação isolada em
`codex/m71-assistant-session`; não autoriza merge na principal, push, PR,
deploy ou Docker.

## Capacidade implementada

- `POST /studio/assistant/session` autenticado, same-origin e protegido por
  CSRF;
- organização, tenant, papel, repositório, `cwd` e preset derivados somente no
  servidor;
- criação e adoção por `sessionController` real com preset fixo
  `dz23-assistant`;
- vínculo da sessão do Harness à sessão de identidade;
- retomada somente quando `inspect` confirma o mesmo preset e repositório;
- seleção pelo contrato existente `dsh.sessions.current` e encaminhamento ao
  chat oficial do Harness;
- `assistant-bridge` isolado por sessão com `cordis:group`, sem serviço global
  compartilhado entre conversas;
- falhas internas observáveis por fase, sem expor detalhes ao cliente.

## Provas executadas no WSL2/ext4

Prova focada inicial: `/home/leandro/dz23-gates/m71-fe32fee`. Prova final em
clone novo: `/home/leandro/dz23-gates/m71-clean-622cc03`, atualizada por
fast-forward ao pin `7a11f6676f3d4326aa835279683a0c9f9f888585`. Harness clonado da origem,
fixado em `6c705be1ce6774a000d061da41d1823b03a3d42c` e compilado pelo
`build:official`. O manifesto conferiu 8.953 entradas e SHA-256
`862b92782c2f5cd67f81debd1116b16150dfafd84fb4ce2602a729f9cf3d26dc`.

O runtime real abriu o profile `studio` em porta efêmera, usou login por código
capturado no modo local, criou a sessão via HTTP real, consultou o Agent do
Harness e executou um turno completo do motor de conversa com o provedor
determinístico de prova. Resultado:

```text
DZ23_STUDIO_M71_ASSISTANT_SESSION=PASS
transport=real HTTP on loopback
sessionController=real
identity=real login + CSRF + revocation
agentPreset=dz23-assistant
governedTools=13
conversationTurn=PASS_WITH_DETERMINISTIC_PROVIDER
approval=ask -> allowed-once
resumedSameSession=true
```

A prova negativa sem CSRF retornou 401. Depois da revogação da sessão de
identidade, uma nova abertura também retornou 401. A sessão criada apresentou
o `cwd` do repositório temporário e o preset exato. A segunda abertura retornou
o mesmo `session_id`. Entre as duas aberturas, a mensagem entrou pelo `Agent`
real, o adaptador determinístico solicitou `studio_echo`, o policy/approval do
Harness registrou uma única decisão `allowed-once` e a resposta
`STUDIO_ECHO_OK` ficou no histórico da sessão. Isso prova o encadeamento da
conversa, não a qualidade nem a disponibilidade de um modelo externo.

O primeiro boot real encontrou um defeito de composição: o serviço da ponte
era publicado globalmente, embora fosse criado por sessão. O preset foi
corrigido para um grupo Cordis com `isolate.studioAssistant: true`; o boot e a
prova passaram depois da correção. O gate do pacote agora exige esse isolamento.

O primeiro gate de i18n no clone novo também falhou por onze mensagens da M71
embutidas em código. Todas foram movidas para os catálogos pt-BR no commit
`7a11f66`; a repetição passou com 12 catálogos, 287 chaves e nenhum crescimento
do baseline legado.

Testes focados após a correção:

- `assistant-bridge/service` + `studio-web/assistant-session`: 58/58;
- cobertura dos dois serviços críticos: 100% statements, branches, functions
  e lines;
- helpers/componentes de abertura da interface: 3/3;
- `ASSISTANT_PACKAGE_PROOF=PASS`, pacote staged com exatamente treze
  ferramentas e somente `spawn-in-process`.

Gate cumulativo no clone novo:

- build oficial do upstream e build da interface + 16 plugins: PASS;
- `pnpm typecheck`: PASS;
- suíte raiz com cobertura e um worker: **2.027 PASS / 62 SKIP / 0 FAIL**,
  125 arquivos aprovados e 6 specs PostgreSQL puladas por ausência de DSN;
- cobertura global: 96,11% statements, 93,56% branches, 96,61% functions e
  98,14% lines; `assistant-session.ts` em 100% nas quatro métricas;
- interface separada: **56/56 PASS**;
- catálogo, 24 rotas de domínio, i18n, upstream pin, portabilidade, pacote e
  runtime da sessão: PASS.

## Limites honestos

- o único turno usa `studio-fake/studio-deterministic`, exclusivo de prova;
  nenhum turno com DeepSeek, Ollama, Codex CLI ou Claude Code real foi enviado:
  `NOT_EXECUTED`;
- o redirecionamento e a gravação no navegador estão cobertos por unidade, mas
  não foram executados em Chromium: `UNIT_PROVEN_NOT_BROWSER_EXECUTED`;
- o cliente do Harness não isola sua lista/histórico de sessões por tenant;
  instalação de equipe/multiusuário para conversas é `NOT_SUPPORTED`;
- PostgreSQL físico, reinício, celular, HTTPS e operação prolongada não foram
  executados;
- as seis specs PostgreSQL foram puladas nesta máquina; M71 não acrescenta
  persistência PostgreSQL nova e não usa esse skip como prova de banco;
- os `plugins/*/lib/**` rastreados e defasados continuam preservados por decisão
  de processo; removê-los do índice exige autorização separada.

O resultado não transforma o produto em “pronto” nem valida a experiência para
pessoas leigas.
