# PoC-01b — prova viva do núcleo no WSL2 ext4

Data: 2026-09-01  
Decisão: **GO**

## Escopo fixado

- upstream: `deepseek-ai/deepseek-harness` no commit `6c705be1ce6774a000d061da41d1823b03a3d42c`;
- checkout upstream: `/home/leandro/harness-studio-poc02/deepseek-harness`;
- cópia descartável do Studio: `/home/leandro/harness-studio-poc01b-20260901/studio`;
- filesystem confirmado por `findmnt`: `ext4`;
- domínio lógico `studio.hello` e domínio físico `studio_hello`, conforme ADR-001;
- telemetria desativada e provedor determinístico local, sem chave de API.

## Evidência executada

O runner `scripts/prove-runtime.mjs` inicializou o profile `studio` pelo boot real
do Harness, montou o preset oficial `standard` e criou uma sessão real. A prova
verificou:

1. catálogo vivo contendo `studio_echo` e `bash`;
2. política de aprovação `ask`;
3. decisão explícita `allowed-once` para `studio_echo`;
4. par durável `approval/asked` + `approval/decided` no log da sessão;
5. execução e persistência do registro tipado do domínio `studio_hello`;
6. escrita real permitida dentro do workspace em modo `workspace-write`;
7. tentativa real de escrita no diretório pai bloqueada pelo sandbox;
8. ausência do arquivo que a tentativa de fuga tentava criar;
9. flush e encerramento da primeira instância;
10. segunda inicialização do mesmo profile;
11. restauração do registro do domínio;
12. retomada da mesma sessão persistida;
13. resposta `RESTART_OK history_restored=true` usando o histórico anterior.

Resultado estruturado principal:

```json
{
  "decision": "GO",
  "platform": "linux",
  "filesystem": "WSL2 ext4 (/home)",
  "logicalDomain": "studio.hello",
  "physicalDomain": "studio_hello",
  "approval": {
    "policy": "ask",
    "outcome": "allowed-once",
    "requests": 1
  },
  "sandbox": {
    "mode": "workspace-write",
    "insideWrite": "allowed",
    "outsideWrite": "denied",
    "outsideMarkerExists": false
  },
  "persistence": {
    "sessionResumed": true,
    "historyRestored": true,
    "domainRecordRestored": true
  }
}
```

## Sandbox e requisito de empacotamento

O WSL2 auditado não tinha `bwrap` global e o snapshot upstream não continha o
binário Landlock pré-compilado que o manifesto descreve. O Harness recusou
corretamente executar sem confinamento. A prova passou depois de apontar, por
overlay exclusivo do PoC, para o Bubblewrap executável já presente na dependência
Linux fixada `@openai/codex@0.149.1-linux-x64`.

Isso não reduz o gate: o comando foi confinado de verdade e a tentativa fora do
workspace foi negada pelo kernel. Para o instalador do Studio, porém, nasce um
requisito obrigatório: detectar e provar um backend de sandbox antes de habilitar
execução de ferramentas. Sem backend utilizável, o produto deve continuar
falhando fechado e explicar a correção em linguagem simples.

## Gates do Studio

- `typecheck`: PASS;
- testes focados: 4/4 PASS;
- cobertura do plugin: 100% statements, branches, functions e lines;
- credencial efêmera do boot: removida;
- arquivo de fuga: ausente;
- upstream: commit exato e worktree limpo, sem qualquer diff.

A baseline conhecida e não verde da suíte upstream continua referenciada em
`docs/baselines/BASELINE-001-deepseek-harness-6c705be.md`; ela não é gate de
commit dos pacotes Studio conforme D30.
