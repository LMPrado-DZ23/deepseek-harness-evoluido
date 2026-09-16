# M77 — Executor da prova real do lifecycle Windows

Estado: **PREPARED_NOT_EXECUTED**. Base M76:
`278840fb8171a309c11e5a32433f2cb2d4309190`. Implementação isolada em
`codex/m77-windows-lifecycle-runner`; não autoriza merge na principal, push,
PR, deploy, inicialização do Docker ou execução do lifecycle real.

## O que foi construído

`deploy/windows/Invoke-Dz23LifecycleProof.ps1` orquestra dezesseis operações e
uma fase de finalização de evidências:

1. snapshot do trust store;
2. preflight de ambiente descartável;
3. instalação e diagnóstico da release inicial;
4. criação de um sentinela PostgreSQL aleatório;
5. atualização saudável e diagnóstico;
6. atualização com imagem inoperante, que precisa falhar com rollback saudável;
7. diagnóstico independente depois do rollback;
8. desinstalação preservando dados;
9. reinstalação da release saudável e novo diagnóstico;
10. verificação do sentinela persistente;
11. desinstalação final preservando dados;
12. novo snapshot, comparação do trust store e hashes das evidências.

Sem `-Execute`, o runner não consulta Docker, não cria diretórios e retorna
`PREPARED_NOT_EXECUTED`. A execução real exige confirmação literal, três
checkouts físicos limpos em commits diferentes, três imagens do Studio e uma
imagem do Caddy fixadas por digest, Docker Desktop já iniciado externamente e
ausência total de instalação, contêiner, volume ou rede DZ23 preexistente.

O runner nunca chama `-PurgeData`, nunca inicia o Docker Desktop e não faz
limpeza automática depois de falha. O relatório omite caminho de segredo e
token do sentinela, recusa sobrescrever evidência, mantém lock exclusivo e é
reescrito atomicamente a cada fase.

## Achado de segurança e correção

O scan inicial encontrou uma falha ALTA de integridade no commit `6d3bc5e`: o
gancho `OperationInvoker`, habilitado por variável de teste, podia substituir
todas as operações e ainda gerar `PASS`. Isso permitiria produzir uma prova
falsa sem Docker ou WSL2.

O commit `78e80451af4b93df855b961f765b2273e01734fa` fechou o caminho:

- uso do gancho produz somente `SIMULATED_PASS`;
- `final_state=SIMULATED_NO_REAL_STATE_CHANGE`;
- `source_and_images=PARTIAL_OR_NOT_VERIFIED`;
- `docker_containers=SIMULATED_ONLY`;
- o teste recusa literalmente qualquer `"state": "PASS"` na simulação;
- somente a execução sem `OperationInvoker` pode emitir `PASS`;
- os três checkouts e quatro digests são verificados no preflight antes da
  instalação inicial.

## Provas executadas

```text
node --test tests/m6/windows-*.test.mjs
tests=18 pass=18 fail=0 duration=212071.3634ms
M6.4-A Windows preflight: PASS (19 cenários herméticos e adversariais)
M6 Windows shell: PASS (PowerShell e Bash reais, Docker isolado)
M77_LIFECYCLE_RUNNER=PASS
```

```text
PORTABILITY_SELF_TEST=PASS negative_fixture_rejected=true
PORTABILITY=PASS source=git findings=0
```

Gate P37 sobre a árvore final:

```text
status=PASS
files_scanned=846
package_manifests=22
license_files=1
findings=0
```

O typecheck raiz não executou: o checkout isolado não materializa o pacote
workspace `@deepseek-ai/dsh-storage`. M77 não acrescenta TypeScript de produção
e essa limitação não foi convertida em resultado verde.

## Auditoria de segurança

- scan do candidato `278840f..6d3bc5e`:
  `d9a5e0ac-0309-4c41-90a7-3da40094e095`, cobertura completa, um achado ALTO
  (`simulated-lifecycle-reported-as-real`);
- correção: `78e80451af4b93df855b961f765b2273e01734fa`;
- scan de verificação `6d3bc5e..78e8045`:
  `7f9cd048-06e6-4a4f-963b-585ef24549c4`, cobertura completa da única
  superfície de produção alterada, zero achados;
- TAC consultivo permaneceu indisponível porque o conector não estava
  autenticado;
- revisão delegada permaneceu indisponível; o diff limitado foi revisado
  sequencialmente pelo agente principal.

Relatório de verificação:
`C:/Users/<voce>/.codex/security-scans/m77-windows-lifecycle-runner/78e80451af4b93df855b961f765b2273e01734fa_20260906T202859Z_jjz25gvk/report.md`.

## Limites honestos

- Docker Desktop permaneceu desligado;
- nenhuma imagem real do produto foi iniciada;
- instalação, atualização, rollback e reinstalação reais continuam
  `NOT_EXECUTED`;
- o runner e sua simulação estão provados, não o lifecycle externo que ele
  executará;
- nenhum merge, push, PR, deploy, purge, limpeza ou exclusão foi realizado.

O M77 reduz o trabalho manual e impede que uma simulação seja confundida com o
gate real, mas não muda sozinho a classificação BETA do Windows.
