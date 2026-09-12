# ADR-020 — Aprovações, tentativas e isolamento do pipeline

- Estado: Aceita
- Data: 2026-09-03
- Ressalva: para a fatia 1

Aprovar o plano e iniciar a geração offline são T1. Preparar dependências com
rede é T2. Segredos, rede externa e qualquer deploy são T3 com identidade forte
e não fazem parte desta fatia. O pipeline executa em contêiner descartável sem
rede, privilégios ou capacidades, com raiz somente leitura e uma única montagem
gravável para a execução.

`--approve-t2` é uma confirmação explícita do operador durante o setup e não é
uma aprovação emitida pelo policy engine em runtime. O arquivo
`runtime/builder-image-digest` fixa o ID da imagem construída neste computador,
não um digest publicado em registro. O setup se recusa a sobrescrevê-lo sem a
segunda confirmação `--replace-existing`. Em Linux, o contêiner recebe o UID/GID
do operador para que apenas o diretório da execução continue gravável; o usuário
da imagem é a alternativa não-root para ambientes sem essa API.

São permitidas no máximo três tentativas. Falhas são distinguidas entre geração,
build e testes. `BLOCKED_EXTERNAL` encerra antes da geração quando o construtor
isolado não está disponível. Logs e relatórios são evidências com SHA-256. O
estado final desta fatia é somente `VERIFIED_PROTOTYPE`. O campo persistido
`sandbox: full` significa especificamente o isolamento do construtor em
contêiner sem rede e sem capacidades; não afirma uso do `ctx.sandbox` do Harness.

Antes do build, o Studio compila a AppSpec em
`tests/e2e/appspec.spec.ts`. Página, seção, item, idioma, título e critérios com
texto literal viram verificações executáveis. O relatório por critério distingue
`PASSED`, `FAILED` e `NOT_AUTOMATED`; somente os verificáveis precisam estar em
`PASSED` para permitir `VERIFIED_PROTOTYPE`.
