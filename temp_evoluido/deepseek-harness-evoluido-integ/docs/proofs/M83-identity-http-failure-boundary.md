# M83 — limite de Cookie e falhas opacas na identidade HTTP

Data: 07/09/2026. Estado: **GO técnico isolado** em
`codex/m83-identity-http-boundary`. Base imutável:
`4fddc1236241f7a5b99984eefc203e7ab41e0a5a`. Código funcional:
`e16a2a7aefc03e94362c67e1eb3bc84e4c66f064`. Harness upstream preservado em
`6c705be1ce6774a000d061da41d1823b03a3d42c`.

Esta prova não autoriza merge, push, PR, deploy ou remoção de artefatos
compilados rastreados.

## Problema fechado

- o limite explícito do cabeçalho `Cookie` é 8 KiB; exatamente 8.192 bytes são
  aceitos e 8.193 bytes são recusados com HTTP 431 e corpo constante
  `COOKIE_HEADER_TOO_LARGE`;
- a verificação ocorre antes de confiança da borda, Host/Origin, roteamento,
  divisão/decodificação de cookies e autenticação;
- a recusa 431 não autentica, revoga sessão nem emite `Set-Cookie`;
- o teto independente de 64 candidatos únicos de sessão permanece ativo para
  entradas que cabem no orçamento de bytes;
- erros de identidade conhecidos preservam 401/404/429 e mensagens próprias;
- JSON inválido, tipo de conteúdo incorreto, corpo grande demais e validação de
  schema permanecem erros 400 conhecidos;
- exceções inesperadas, inclusive valores lançados que não são `Error`, viram
  HTTP 500 com corpo constante `IDENTITY_INTERNAL_ERROR`, sem mensagem, stack,
  caminho ou segredo interno.

## Provas executadas

Clone descartável em ext4 do WSL2:
`/home/leandro/dz23-gates/m82-clean-4fddc12`, com Node 22 e pnpm 11.7.0. O
patch M83 foi aplicado ao clone somente para validação; a fonte oficial da
fatia permanece na branch acima.

- conteúdo e pin do upstream, incluindo autotestes negativos: `PASS`;
- instalação congelada, build oficial do Harness e build do Studio com
  `CI=true`: `PASS`;
- `pnpm typecheck`: `PASS`;
- gate i18n: `PASS`, 12 catálogos e 290 chaves;
- teste focado `plugins/identity/tests/http.spec.ts`: 21/21 `PASS`;
- suíte determinística pós-M83 com
  `CI=true pnpm exec vitest run --maxWorkers=1`: 125 arquivos e 2.034 testes
  `PASS`; 6 arquivos e 62 testes PostgreSQL `SKIPPED`; zero falha; duração
  220,22 s;
- `git diff --check`: `PASS`.

O primeiro install/build sem `CI=true` revelou que o `postinstall` vendorizado
do Harness rejeita a topologia normal de submódulo por causa de
`core.worktree`. Não houve contorno silencioso: o script do próprio upstream
declara CI como caminho suportado, e todos os comandos finais foram repetidos
com a variável explícita.

## Auditoria de segurança

Scan de diff Codex Security:
`5d1b957e-7b22-4639-8220-97733846108b`.

- snapshot:
  `codex-security-snapshot/v1:sha256:7fc2119643b0a03fde9fb3d79db3430efb34080b52454c1771aede4b0682eb12`;
- superfícies: entrada não autenticada, cookies duplicados, logout/CSRF,
  efeitos colaterais e confidencialidade de diagnósticos;
- cobertura: completa para o diff congelado;
- revisão independente adicional: `GO`;
- achados reportáveis: **0**.

Relatório canônico local:
`C:\Users\<voce>\.codex\security-scans\m83-identity-http-boundary\4fddc1236241f7a5b99984eefc203e7ab41e0a5a_20260907T050121Z_j_crqv_9\report.md`.

O conector TAC ficou indisponível durante a varredura; portanto não foi usado
como evidência e nenhum resultado depende dele.

## Limites honestos

- PostgreSQL físico e injeção de falha real no armazenamento:
  `NOT_EXECUTED`;
- Caddy/Docker implantados e validação do limite combinado da borda:
  `NOT_EXECUTED`;
- múltiplas linhas HTTP `Cookie` enviadas por socket cru: `NOT_EXECUTED`; o
  contrato exercitado usa o valor normalizado fornecido por `node:http`;
- Windows, domínio real, celular físico e operação prolongada:
  `NOT_EXECUTED`.

## Decisão técnica

M83 fecha a fronteira local de disponibilidade e confidencialidade do handler
de identidade sem ampliar autoridade nem alterar a semântica de autenticação.
O checkpoint está pronto para parecer independente do Claude. A principal
permanece intacta; qualquer integração depende de autorização e revisão.
