# P34 — Preview seguro: prompt de revisão e execução

## Identidade obrigatória

- Repositório: `C:\Users\zodyp\Documents\Codex\2026-09-01\com\work\poc-01-studio`
- Base canônica: `codex/p30-policy-foundation@69dc354e989728d62ce5a715c9066188a1448f48`
- Código da P32 revisado pelo Claude: `58f77d3`; `69dc354` é seu descendente
  e acrescenta somente o fechamento documental do merge.
- Criar worktree e branch novos: `codex/p34-preview-core`.
- Não reutilizar worktrees históricos; não editar o Harness upstream.
- Sem merge, push, PR, exposição pública ou deploy nesta missão.

P34 core pode começar em paralelo com a conclusão de SaaS/dashboard, mas a
fase 6 não pode ser declarada fechada antes da fase 5 completa.

## Objetivo

Entregar preview privado e temporário do artefato exato já verificado, sobre
HTTPS local pelo Caddy, em iframe de origem isolada, com sessão e tenant
revalidados, lifecycle persistido, encerramento automático e runtime sem rede
de saída. Staging, publicação e produção permanecem fora.

## Leitura obrigatória antes do código

Ler integralmente o Plano Mestre v2, a capability matrix e os ADRs 005, 007,
010, 011, 012, 020, 021, 022 e 024. Registrar threat model com quatro zonas:
navegador/iframe, Caddy, supervisor/gateway confiável e aplicação gerada não
confiável.

## P34-A — fechar residuais da fonte gerada

Estender `assertGeneratedSource` com AST, antes de qualquer escrita ou execução:

1. recusar a diretiva `'use server'` em qualquer função ou bloco, não apenas no
   topo do arquivo;
2. recusar uso executável de `fetch`, `WebSocket` e `XMLHttpRequest`, inclusive
   referência direta, chamada, `new`, property access e element access com chave
   literal;
3. não acusar comentários ou strings comuns que apenas mencionem esses termos;
4. manter erro `GENERATED_FILE_REJECTED` e diagnóstico seguro para nova geração.

Testes obrigatórios: função e arrow com `'use server'`; `fetch(...)`,
`(0, fetch)(...)`, `window.fetch`, `window['fetch']`; `new WebSocket`,
`window['WebSocket']`; `new XMLHttpRequest`, `window['XMLHttpRequest']`; casos
positivos de comentários/strings e `'use client'`.

O scanner não substitui a barreira de runtime: CSP e ausência de egress são
controles independentes.

## P34-B — contrato e lifecycle tenant-aware

Criar domínio `studio_previews`, schemas Zod e contratos com:

- `preview_id`, `org_id`, `tenant_id`, `project_id`, `run_id`;
- `artifact_sha256`, `created_by`, `source_session_id`;
- estado, timestamps, motivo de parada, código de falha e health;
- referência interna opaca ao runtime, nunca host, porta ou container id no
  cliente.

Estados:

`REQUESTED → STARTING → READY → STOPPING → STOPPED`, com terminais `FAILED` e
`EXPIRED`.

TTL padrão 30 minutos e máximo 2 horas, definido apenas pelo servidor. Start e
stop idempotentes, concorrência serializada por projeto/preview, reaper com
relógio injetável e reconciliação de órfãos após restart. Só aceitar run
`PASSED` de projeto `VERIFIED_PROTOTYPE` e hash de artefato correspondente.

## P34-C — runtime sem egress

- Criar `PreviewRuntimePort`, separado do builder de comandos curtos.
- Nenhum host, URL, porta, comando, imagem ou path vem do navegador.
- Imagem fixada por digest; non-root; rootfs read-only; `CapDrop=ALL`;
  `no-new-privileges`; tmpfs e limites de CPU, memória e PIDs.
- Diretório de dados exclusivo é a única montagem gravável.
- Não montar Docker/Podman socket, trust store, credenciais ou filesystem do
  Harness.
- Não herdar `process.env`; usar allowlist explícita sem DSN, SMTP, tokens,
  chaves ou códigos.
- Rede privada por preview: gateway consegue entrar, aplicação não consegue
  sair para internet, DNS, metadata, host, Harness ou Postgres.
- Se ingresso sem egress não puder ser provado sem privilégio perigoso, parar
  como `BLOCKED_EXTERNAL`; não degradar silenciosamente.

## P34-D — Caddy, HTTPS e iframe

- Caddy continua a única borda HTTPS.
- Origem distinta e não adivinhável por preview:
  `p-<id-aleatorio>.preview.<dominio-configurado>`.
- Todos os hosts chegam a um gateway fixo; o gateway consulta a registry
  server-side e encaminha somente ao endpoint emitido pelo runtime.
- Nunca selecionar upstream por `Host`, DNS ou destino enviado pelo cliente.
- Preservar `X-Frame-Options: DENY` e `frame-ancestors 'none'` no Studio.
- Somente no host de preview, substituir por CSP com
  `frame-ancestors <origem HTTPS exata do Studio>`, `default-src 'self'`,
  `connect-src 'self'`, `form-action 'self'`, `base-uri 'none'` e
  `object-src 'none'`.
- Iframe: `sandbox="allow-scripts allow-forms allow-same-origin"` e
  `referrerpolicy="no-referrer"`; sem popup, top-navigation ou download.
- Prova local usa `tls internal` com CA confinada ao ambiente de teste; nunca
  instalar CA no host nem alterar hosts do sistema.
- ACME e domínio público permanecem `NOT_EXECUTED`.

## P34-E — autenticação, autorização e cookies

- URL opaca não é credencial.
- Start/stop exigem sessão Studio ativa, CSRF, membership do servidor,
  `project.write` e tier T1; leitura exige `project.read`.
- `org_id`/`tenant_id` enviados pelo navegador nunca são autoridade; tenant
  divergente responde 404.
- Emitir admissão opaca e persistir somente hash, vinculada a preview, usuário,
  sessão Studio, organização e tenant.
- Cookie host-only `__Host-*`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`;
  expiração limitada ao menor valor entre TTL e sessão Studio.
- Não introduzir `Secure=false` para HTTP, localhost, `NODE_ENV` ou
  `X-Forwarded-Proto`.
- Revogação, remoção da membership, stop ou expiração bloqueiam a próxima
  requisição.

Rotas estruturais sugeridas:

- `POST /api/studio/apps/projects/:projectId/previews`
- `GET /api/studio/apps/projects/:projectId/previews/:previewId`
- `DELETE /api/studio/apps/projects/:projectId/previews/:previewId`
- `POST /api/studio/previews/admission/exchange`
- `GET /api/studio/previews/authorize`

Não criar segunda autoridade de RBAC.

## P34-F — testes e prova adversarial

Executar unitários, integração real com Caddy/runtime e Playwright HTTPS:

- lifecycle, TTL, idempotência, concorrência, reaper e restart;
- 401 anônimo e 404 de tenant cruzado;
- sessão e membership revogadas;
- Host e Origin falsos;
- destino/porta injetados, loopback, IPv6, metadata `169.254.169.254`, hostname
  arbitrário e DNS rebinding;
- conexão HTTP/TCP/DNS externa a partir do runtime;
- acesso direto ao runtime;
- cookie Secure armazenado/enviado em HTTPS, ausente de `document.cookie` e não
  enviado por HTTP;
- iframe só na origem Studio autorizada;
- TTL remove runtime e stop repetido permanece idempotente;
- restart elimina órfãos e não adota runtime desconhecido;
- nenhum segredo, token, cookie, código, DSN, ambiente bruto, endpoint interno
  ou path sensível nos logs e no bundle.

Rodar pnpm 11.7.0, typecheck, cobertura, build, i18n, domínios, P37, validação
Caddy, inspeção do runtime e Playwright. Teste com fake não substitui lifecycle
real; estado deve ser `NOT_EXECUTED` quando a prova real não ocorrer.

`PREVIEW_OK` só pode referenciar o `run_id` e `artifact_sha256` realmente
provados. Atualizar a matriz para BETA somente com todos os gates reais. Não
chamar preview de aplicação publicada ou pronta.

## Commits isolados esperados

1. `fix(prompt-to-app): close generated source residuals`
2. `feat(preview): add tenant-aware lifecycle and isolated runtime`
3. `feat(preview): add authenticated HTTPS edge and iframe`
4. `test(preview): add adversarial proof and evidence`
5. `docs(preview): record exact capability state`

Parar após commits e evidências para revisão independente. Não fazer merge,
push, PR ou deploy.
