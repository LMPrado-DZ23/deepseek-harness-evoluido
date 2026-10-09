# M6.3 — Prompt-to-App lifecycle adapter A

Estado: `IMPLEMENTED_FOCUSED_PROOF`; ingresso autenticado de artefato: `NOT_PRESENT`; integração real com o supervisor e Docker: `NOT_EXECUTED`; promoção para protótipo verificado: `BLOCKED_EXTERNAL` até a Fatia B.

Base: `codex/m63-integration-candidate@a68530146659e1ab92089c94c832e1d8d5cd68dc`.

## Limite desta fatia

Esta fatia substitui a autoridade direta de processo/contêiner do Prompt-to-App por `BuilderLifecycleResolverPort.forActor(actor)`. A sessão retornada oferece somente `preflight`, `prepare`, `execute(BuildStep)`, `cancel`, `finish` e `listManaged`. Socket, credencial, imagem, mounts, comandos e o identificador físico de escopo não atravessam esse contrato.

As tentativas de staging em filesystem compartilhado foram removidas após reproduções de troca de subdiretório por symlink/junction. O preflight valida registry, escopo e attestation, mas permanece `BLOCKED_EXTERNAL`: `prepare` e `execute` sempre encerram com `UNSUPPORTED_INGRESS` antes de ler a origem, abrir o cliente ou escrever no `artifactRoot`. Não existe chave de configuração ou rota HTTP capaz de habilitar o caminho removido. `cancel`, `finish` e `listManaged` permanecem disponíveis somente para reconciliação/cleanup de runs já gerenciadas pelo supervisor.

O protocolo desta fatia também não entrega o relatório de aceitação exportado por um canal autenticado. Portanto, até um fake que declare `E2E_OK` com export e cleanup válidos termina em `BLOCKED_EXTERNAL/ACCEPTANCE_ATTESTATION_UNAVAILABLE`; o relatório `PENDING` da origem, inclusive se adulterado localmente para `PASSED`, nunca é promovido nem aceito como prova. A futura Fatia B precisa fornecer upload/stream autenticado ou helper nativo `openat` comprovado e validar o artefato exportado.

## Invariantes implementados

- escopo físico deriva de `org_id + tenant_id + installation_id + prompt_app_v1` por hash com domínio e versão;
- autorização usa a policy `project.write`: viewer é recusado antes de ler registry/configuração, enquanto owner/admin/builder seguem para resolução; o escopo físico ainda impede cruzamento de organização/tenant;
- slot ativo, configuração pinada e attestation precisam corresponder ao mesmo escopo, digest e política; mesmo uma attestation correta não anuncia capacidade de build sem ingresso autenticado;
- a credencial é reaberta a cada RPC com `O_NOFOLLOW`, arquivo regular, `nlink=1`, owner/mode privados, identidade inode/path estável e UTF-8 fatal;
- `operationId`/`runId` aceitam somente identificadores opacos estritos antes de qualquer composição de path;
- nenhuma árvore é copiada para o `artifactRoot`; `prepare` e `execute` falham fechados para paths Linux, junctions Windows, build refs fornecidos diretamente e qualquer opção extra de configuração;
- o contrato conserva somente `BuildStep` enumerado (`install`, `build`, `test`, `e2e`), nunca comando shell; produção não despacha nenhum step enquanto o ingresso estiver ausente;
- aborto usa sinal novo e limitado para `cancel` seguido de `finish`;
- `E2E_OK`, export não nulo, `cleaned=true` e `cleanup_pending=false` são necessários, mas ainda insuficientes sem o relatório exportado autenticado da Fatia B;
- resposta de `finish` ou cleanup inconclusiva nunca produz `PASSED`.

## Prova focada

Comando:

```text
vitest run --config vitest.config.ts \
  plugins/prompt-to-app/tests/builder-lifecycle.spec.ts \
  plugins/prompt-to-app/tests/pipeline.spec.ts \
  plugins/prompt-to-app/tests/generator-runner.spec.ts
```

Resultado atual: `61 passed`, `1 skipped` no Windows, incluindo o contrato de exportação do Integration Hub e o gate dos consumidores oficiais. O skip é a política POSIX de link do template no pipeline. As mutações Linux/Windows de ingresso compartilhado executaram e provaram `UNSUPPORTED_INGRESS` sem chamar `client.prepare`; a suíte também prova que preflight saudável não libera a capacidade e que o pipeline não promove relatório local pendente ou forjado.

Cobertura V8 focada, protegida por threshold explícito no `vitest.config.ts`: `builder-lifecycle.ts` = **100/100/100/100** e `builder-resolver.ts` = **100/100/100/100** em statements/branches/functions/lines. Os testes exercitam preflight adulterado ou indisponível, escopos divergentes, RBAC, estados retiring, sucesso e falha de cancel/finish/listManaged, classificação de transporte e a leitura de credencial em casos de path hostil, troca de identidade, NUL, UTF-8 inválido, terminadores LF/CRLF e falha do sistema operacional.

O fechamento da credencial faz parte do resultado fail-closed: rejeição de `close()` após leitura válida vira `BLOCKED_EXTERNAL/CREDENTIAL_UNAVAILABLE`, enquanto uma falha principal já sanitizada é preservada se o fechamento também falhar. Ambos os caminhos fecham o handle exatamente uma vez e não expõem a mensagem privada do sistema operacional.

Os consumidores oficiais de prova e o servidor E2E foram migrados para `BuilderLifecycleResolverPort` com fake explicitamente fail-closed. Eles preservam geração declarativa e isolamento quando aplicável, mas registram ingresso `NOT_PRESENT`, build/teste/E2E `NOT_EXECUTED` e promoção/exportação `BLOCKED_EXTERNAL`. O gate de símbolos não encontra imports da autoridade removida nos diretórios de runtime, scripts ou testes migrados, e esses harnesses não contêm subprocesso nem socket Docker.

## Não executado

- Docker/Podman real;
- socket Unix real contra o manager;
- montagem real do template store;
- exportação real e consumo pelo preview/Hub;
- prova POSIX completa no Linux;
- suíte completa e coverage (aguardando a janela coordenada de gate pesado).
