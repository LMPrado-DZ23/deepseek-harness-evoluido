# Prova M3 — endurecimento do armazenamento PostgreSQL (achados da revisão adversarial do Codex)

Status: **BETA**. Todas as regressões abaixo rodaram contra um PostgreSQL 16 real e local
(`postgresql://dz23_test@127.0.0.1:5432/dz23_test`, `ssl off`). As provas de runtime que sobem o
Harness (`prove:backup-restore`, `prove:storage-migration`, `prove:postgres-runtime`) estão
**NOT_EXECUTED** neste ambiente — elas falham na resolução do pacote
`@dz23-studio/storage-postgres` a partir do perfil em `runtime/`, **antes e depois** desta mudança
(verificado com `git stash`), ou seja, é limitação do ambiente, não regressão desta fatia.

## Como rodar

```
PATH=/root/shim:$PATH DZ23_POSTGRES_TEST_DSN=postgresql://dz23_test:dz23test@127.0.0.1:5432/dz23_test \
  DZ23_POSTGRES_TEST_CONTAINER=shim npx vitest run plugins/storage-postgres --reporter=dot
```

Resultado desta prova: **10 arquivos, 65 testes, 65 aprovados** (`pnpm typecheck` limpo, `pnpm gate:i18n`
`I18N_GATE=PASS locale=pt-BR keys=199`). Nesta árvore, hoje, o mesmo comando dá **10 arquivos, 70
testes, 70 aprovados**: cinco testes foram acrescentados depois desta prova (medido em 04/09/2026).

## Regra desta prova

Um teste que não pode falhar é pior que teste nenhum. Cada correção abaixo foi verificada por
**mutação**: a correção é desfeita no código, o teste correspondente é executado, e a falha
observada está transcrita. Depois a correção é restaurada.

| # | Correção | Teste | Mutação aplicada | Falha observada |
|---|----------|-------|------------------|-----------------|
| 1 | Catálogos da sonda de conteúdo derivados do `pg_catalog` (`scripts/import-postgres-storage.ts`) | `restore CLI hardening > treats a schema holding only a TEXT SEARCH CONFIGURATION as content...` | volta à lista à mão (`pg_class`, `pg_proc`, `pg_type`, `pg_operator`, `pg_collation`) | `promise resolved "{ …(2) }" instead of rejecting` — a CLI **apagou** o esquema alheio e escreveu (`"mode": "write", "domains": 21`) |
| 2 | Varredura de preparo com forma exata + marca de propriedade | `restore CLI hardening > reaps only its OWN staging schemas...` | volta ao `LIKE '<esquema>_staging_%'` sem escape e sem marca | `expected [ …(3) ] to deeply equal [ Array(1) ]` — apagou também `sweep_..xstaging_alheio` e `sweep_.._staging_alheio` |
| 3a | Política TLS é autoridade única (`plugins/storage-postgres/src/dsn.ts`) | `TLS policy is the single authority > *` (4 casos) | devolver o DSN original em vez do DSN sem parâmetros TLS | `--ssl off` + DSN `sslmode=verify-full` **cifrou**; `--ssl verify-full` + DSN `sslmode=disable` foi **em claro** (`expected [ { ssl: false, handshake: 'none' } ] to deeply equal [ { ssl: true, …(1) } ]`) |
| 3b | Senha nunca no `argv` do `pg_dump` | `restore CLI hardening > never puts the password or the TLS policy on the pg_dump command line` | volta a montar `--dbname=<DSN completo com senha>` | `expected '--dbname=postgresql://dz23_test:dz23t…' not to contain 'dz23test'` |
| 4 | Sessão da unidade toma a trava de manutenção compartilhada | `postgres backend ... > keeps a writer and a restore from ever overlapping...` | remover o `pg_try_advisory_lock_shared` da abertura da unidade | `expected true to be false` — com um escritor **vivo**, a restauração conseguiu a trava exclusiva |
| 5 | Arquivo de saída reivindicado antes da conexão | `hot snapshot ... > leaves no database connection behind when the output file cannot be created` | conectar antes do `open(out, 'wx')` | `expected 3 to be +0` — três tentativas, três conexões penduradas |
| 6 | Forma declarada gravada na unidade (+ impressão digital) | `hot snapshot ... > keeps a declared but empty table, and a declared global nobody wrote, all the way through a restore` | deduzir o descritor só das linhas existentes | `hasGlobal: false` e a tabela `vazia` sumiu do descritor |
| 7a | `verifyBackupFile` em fluxo e teto único de 64 MiB | `StorageBackupScheduler > fails early above the proved JSON ceiling and streams a file within it` | voltar ao `readFile(file)` ou anunciar teto acima do parser JSON | o arquivo acima do teto é recusado por `fstat`; um arquivo dentro do teto atravessa o hash em fluxo |
| 7b | Teto também na cópia manual em memória | `StorageBackupScheduler > refuses an in-process backup over the ceiling instead of filling the disk` | remover a checagem de `maxBytes` | `expected { status: 'created', …(9) } to match object { status: 'failed', file: null }` |
| 8 | Prova ICU falha em vez de sair calada | `hot snapshot ... > seals the same bytes on a database whose locale is NOT C...` | — (já estava corrigido em HEAD; conferido: lança `NOT_EXECUTED` em vez de `return`) | — |

## Cobertura extra que não estava nos achados

- **Matriz TLS hermética.** `plugins/storage-postgres/tests/tls.spec.ts` sobe um servidor que fala
  o suficiente do protocolo do PostgreSQL para responder ao pacote `SSLRequest`, com certificados
  gerados na hora pelo `openssl`. Assim a matriz `off` / `require` / `verify-full` × CA válida /
  CA errada é verificada **sem depender** de como o PostgreSQL da máquina está configurado (o desta
  máquina está com `ssl off`, e um teste que se cala nesse caso seria uma guarda vazia).
- **A varredura de preparo continua varrendo.** O mesmo teste planta um órfão **legítimo** (nome
  certo e marca certa) e exige que ele seja apagado: uma "correção" que simplesmente parasse de
  apagar passaria nas duas primeiras asserções e falharia nesta.
- **Impressão digital do descritor.** Editar `units.tables` na mão passa a ser recusado
  (`malformed-medium`), não acreditado.
- **Falha latente encontrada e corrigida no teste ICU.** Ele comparava `payloadSha256` entre a
  cópia do worker e o snapshot em processo. Esse campo sela `pg_current_snapshot()`, que **qualquer**
  transação do cluster move — o teste falhava de forma intermitente quando a suíte rodava em
  paralelo. Agora a comparação é do payload inteiro com esse marcador mantido igual: a afirmação
  ficou mais forte (todos os domínios, formato, data e pin), não mais fraca.

## O que continua em aberto

- `prove:backup-restore`, `prove:storage-migration`, `prove:postgres-runtime` e
  `prove:postgres-soak`: **NOT_EXECUTED** neste ambiente (resolução de pacote no perfil do
  Harness, falha idêntica antes da mudança).
- A execução em `--dry-run` da cópia manual ainda monta o pacote em memória para contar registros;
  a escrita (`--write`) não. **NOT_VALIDATED** para bancos muito grandes em modo `--dry-run`.
- Compose real em servidor: segue `NOT_EXECUTED` (sem Docker neste ambiente).

## Checkpoint W3 — operador unificado (05/09/2026)

O código atual acrescenta a autoridade única em
`apps/studio-runtime/operator.mjs`, impressão física do destino,
`installation_id` lógico portável, prévia pura, cercas explícitas para perda de
registros, objetos desconhecidos e instalação estrangeira, auditoria dentro da
transação da troca e reconciliação segura após `COMMIT`.

Neste checkpoint, **178 testes que não exigem Docker passaram** e **59
integrações PostgreSQL/Docker foram puladas**. PostgreSQL/Compose real não foi
reexecutado: o Docker Desktop Windows quebrou durante a preparação e está
classificado `BLOCKED_ENVIRONMENT`, não como falha do produto. Os resultados
históricos acima permanecem evidência da revisão anterior, mas não substituem a
prova do operador W3 no ambiente real.
