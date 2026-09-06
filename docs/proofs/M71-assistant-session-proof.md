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

Árvore de prova: `/home/leandro/dz23-gates/m71-fe32fee`. Harness fixado em
`6c705be1ce6774a000d061da41d1823b03a3d42c` e compilado.

O runtime real abriu o profile `studio` em porta efêmera, usou login por código
capturado no modo local, criou a sessão via HTTP real e consultou o Agent do
Harness. Resultado:

```text
DZ23_STUDIO_M71_ASSISTANT_SESSION=PASS
transport=real HTTP on loopback
sessionController=real
identity=real login + CSRF + revocation
agentPreset=dz23-assistant
governedTools=13
resumedSameSession=true
```

A prova negativa sem CSRF retornou 401. Depois da revogação da sessão de
identidade, uma nova abertura também retornou 401. A sessão criada apresentou
o `cwd` do repositório temporário e o preset exato. A segunda abertura retornou
o mesmo `session_id`.

O primeiro boot real encontrou um defeito de composição: o serviço da ponte
era publicado globalmente, embora fosse criado por sessão. O preset foi
corrigido para um grupo Cordis com `isolate.studioAssistant: true`; o boot e a
prova passaram depois da correção. O gate do pacote agora exige esse isolamento.

Testes focados após a correção:

- `assistant-bridge/service` + `studio-web/assistant-session`: 58/58;
- cobertura dos dois serviços críticos: 100% statements, branches, functions
  e lines;
- helpers/componentes de abertura da interface: 3/3;
- `ASSISTANT_PACKAGE_PROOF=PASS`, pacote staged com exatamente treze
  ferramentas e somente `spawn-in-process`.

## Limites honestos

- nenhum turno com DeepSeek, Ollama, Codex CLI ou Claude Code real foi enviado:
  `NOT_EXECUTED`;
- o redirecionamento e a gravação no navegador estão cobertos por unidade, mas
  não foram executados em Chromium: `UNIT_PROVEN_NOT_BROWSER_EXECUTED`;
- o cliente do Harness não isola sua lista/histórico de sessões por tenant;
  instalação de equipe/multiusuário para conversas é `NOT_SUPPORTED`;
- PostgreSQL físico, reinício, celular, HTTPS e operação prolongada não foram
  executados;
- a prova final em clone novo pertence ao fechamento deste checkpoint e deve
  constar aqui antes de pedir revisão independente.

O resultado não transforma o produto em “pronto” nem valida a experiência para
pessoas leigas.
