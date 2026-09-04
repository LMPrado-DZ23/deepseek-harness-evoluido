# ADR-029 — Operação do Studio sobre PostgreSQL (P31-B)

Status: aceita e implementada na etapa M3 (Claude), sobre a base P31-A.

## Decisões

1. **Rotas de domínio têm fonte única.** Todo domínio declarado em
   `scripts/studio-domain-specs.ts` precisa de rota `postgres` nos patches
   `deploy/harness/edge.patch.yml` (produção) e `postgres-proof.patch.yml`
   (provas). O gate `pnpm gate:domain-routes` falha com qualquer domínio sem
   rota, rota desconhecida ou patch sem rota alguma. Antes desta ADR os oito
   domínios do Prompt-to-App caíam no backend `json` em produção sem que nenhum
   teste percebesse; a prova de runtime passa a confirmar cada unidade na
   tabela `units` do esquema, não apenas a abertura do domínio.
2. **Backup lógico a quente, no mesmo formato da migração.** O plugin
   `storage-postgres` expõe `snapshotPostgresStorage`: uma transação
   `REPEATABLE READ READ ONLY` lê `units`, `records` e `unit_globals` sem tomar o
   lock de escritor, produzindo um bundle `dz23-studio-kv-export/v1` — o mesmo
   que `storage:import-postgres` restaura. Não há dependência de `pg_dump` para o
   backup lógico; `pg_dump` continua sendo o backup físico do operador.
3. **Agendamento dentro do Studio, execução FORA do processo dele.** Com
   `backupDirectory` configurado, o plugin agenda a cópia, mas quem a faz é um
   **processo separado** (`backup-worker.js`), com limite de tempo
   (`backupTimeoutMinutes`, 15 min), limite de tamanho (`backupMaxBytes`, 2 GB) e
   heap próprio (`backupHeapMb`, 1 GB). O worker escreve **direto no arquivo**,
   um domínio de cada vez, calculando os dois resumos (o do arquivo e o
   `payloadSha256` canônico) enquanto os bytes passam: o Studio nunca
   materializa o banco inteiro nem o JSON canônico na própria memória — era um
   risco de disponibilidade apontado na revisão da M3. O DSN vai para o filho
   pelo **ambiente**, nunca pela linha de comando. Execuções se enfileiram (uma
   por vez) e uma falha remove o arquivo parcial. O plugin grava
   `studio-backup-<carimbo>.json` (0600) + `.sha256` + ledger
   `backups.jsonl`, apaga só os seus próprios arquivos além de `backupKeep`,
   nunca derruba o Studio por falha de backup (registra e segue) e recusa
   intervalo menor que cinco minutos. Os registros são lidos por **cursor do
   PostgreSQL** (lotes de 500) dentro da mesma transação `REPEATABLE READ`, e o
   domínio é percorrido **duas vezes**: a primeira só para calcular o resumo
   dele, a segunda para escrever o arquivo com o resumo no lugar. Custo: ler
   cada registro duas vezes. Ganho: memória constante — nem o banco inteiro nem
   um domínio inteiro ficam na memória de ninguém. A ordem dos registros vem do
   banco com `COLLATE "C"` (ordem de bytes), que é a ordem que a forma canônica
   exige; a locale do banco ordenaria diferente. **Duas correções da revisão
   adversarial:** o `COLLATE "C"` estava só no nome da tabela e **faltava na
   leitura das chaves** (um `sed` meu o apagou depois de os testes passarem, e o
   teste não pegou porque este banco de teste é `C.UTF-8` — guarda que não pode
   falhar não é guarda); e a forma canônica ordenava por **unidades UTF-16**
   (`<` em JavaScript), que discorda da ordem de bytes para qualquer chave fora
   do BMP: uma única chave com emoji selava um pacote que falhava no próprio
   validador, ou seja, uma cópia de segurança que não restaura. Agora a
   comparação é por bytes UTF-8 (`compareUtf8`) e o teste roda contra um banco
   criado com locale **ICU pt-BR**, onde as ordens realmente divergem —
   verificado por mutação: desfazer qualquer uma das duas correções faz o teste
   falhar. O diretório é um volume dedicado no
   Compose (`studio-backups`). Sem diretório, não há agendamento e o operador usa
   `pnpm storage:backup-postgres`.
4. **Restauração é o caminho já provado, e agora recusa antes de destruir.**
   `storage:import-postgres --write` importa num esquema de staging e troca
   atomicamente. Tudo o que pode recusar acontece **antes** do `pg_dump`, do
   staging e do `DROP SCHEMA`:
   - **Trava de manutenção do esquema inteiro.** O Studio em execução segura
     `dz23-storage-maintenance:<esquema>` em modo **compartilhado** enquanto
     estiver de pé; a restauração e a migração tomam a mesma trava em modo
     **exclusivo**. Antes, só se travavam as unidades **presentes na cópia**: uma
     cópia que não mencionasse a unidade aberta pelo Studio passava direto para o
     `DROP SCHEMA` com o Studio vivo. As travas por unidade continuam, como
     segunda cinta.
   - **Cópia vazia é recusada** antes mesmo de abrir o banco: ela não restaura
     nada, só apaga.
   - **Cópia parcial é recusada**: se o destino tem conjuntos de dados que a
     cópia não traz, restaurar apagaria esses dados — a CLI diz quais são e só
     segue com `--allow-domain-loss --confirm REPLACE_DZ23_STORAGE`.
   - **Estrutura conferida pelo `pg_catalog`**: um esquema que tem uma tabela
     `units` mas não o resto do layout do Studio (ou outra versão de layout) não
     é tratado como esquema do Studio — recusa em vez de apagar algo de outra
     coisa.
   - **Preparo limpo**: qualquer falha derruba o esquema de staging antes de o
     erro subir; nada de meio-esquema esquecido no banco.
   - **A cópia física herda a política TLS**: o `pg_dump` do `--backup` roda com o
     `sslmode` da própria string de conexão forçado a partir do `--ssl` do
     comando (não faz sentido exigir `verify-full` na importação e despejar em
     claro); o resto da string — `sslrootcert`, `sslcert`, `sslkey`, `options` —
     é preservado.
   A prova adversarial dessas regras está em `docs/proofs/P31-B-backup-restore-proof.md`
   (fase 5).

   **Correções da revisão adversarial das próprias correções (04/09, subagentes):** a checagem de
   estrutura estava condicionada à existência de uma **tabela** `units` — exatamente a coisa que ela
   deveria verificar. Um esquema de outro sistema, ou um esquema do Studio cujo `units` fosse uma
   **view**, atravessava as duas travas e chegava ao `DROP SCHEMA` sem `--force`. Agora a condição é
   "o esquema tem qualquer relação": aí a estrutura é exigida e a confirmação também. A trava de
   manutenção passou a ser **supervisionada** — sem ouvinte de `error`, uma queda de conexão
   derrubava o processo por exceção não tratada e, se alguém a engolisse, a garantia sumia em
   silêncio e um restore podia derrubar o esquema de um Studio vivo; agora a perda desliga a
   garantia (abrir unidade nova é recusado), a trava é retomada sozinha, e um `close()` que corra
   com a abertura não deixa sessão órfã. Esquemas de preparo órfãos, de uma execução morta por
   `SIGKILL`, são varridos no início da próxima restauração, sob a trava exclusiva.

   **Terceira passagem adversarial:** "o esquema tem conteúdo" era decidido por `pg_class`, que só
   lista relações — um esquema de outro produto contendo apenas **funções, tipos ou domínios**
   parecia vazio, pulava a checagem de estrutura e a confirmação, e ia direto para o
   `DROP SCHEMA CASCADE` com a invocação mais simples possível. Agora a pergunta cobre `pg_class`,
   `pg_proc`, `pg_type`, `pg_operator` e `pg_collation`, com teste que planta exatamente esse
   esquema e verificação por mutação.

   **Quarta passagem adversarial (Codex, 04/09) — o que ainda estava aberto:**
   - **A lista de catálogos ainda era parcial.** `pg_ts_config`, `pg_ts_dict`, `pg_conversion`,
     `pg_opclass`, `pg_extension` e outros não estavam nela: um esquema com apenas uma
     configuração de busca textual continuava parecendo vazio e ia para o `DROP SCHEMA` sem
     `--force`. A lista deixou de ser escrita à mão: os catálogos são **derivados** do próprio
     `pg_catalog` (toda tabela com coluna `oid` chamada `*namespace`), e os nomes vindos do
     catálogo ainda passam por uma checagem estrita de identificador antes de entrar na consulta.
   - **A varredura de esquemas de preparo podia apagar esquema alheio.** O `LIKE
     '<esquema>_staging_%'` nunca escapou o `_`, que é curinga: `dz23_storagexstaging_...`, de
     outro dono, casava e era apagado com `CASCADE`. Agora são duas condições independentes: o
     nome precisa ter exatamente a forma `<esquema>_staging_<sufixo>` (expressão regular, não
     `LIKE`) **e** o esquema precisa carregar a tabela-marca `dz23_import_staging` que esta
     ferramenta escreve — na mesma transação que cria o esquema de preparo, para que um preparo
     sem marca não possa existir.
   - **A política TLS não era autoridade única.** O `pg` mistura a string de conexão **por cima**
     das opções explícitas (`Object.assign({}, config, parse(connectionString))`), então um DSN
     com `sslmode=disable` desligava em silêncio um `--ssl verify-full`. Agora existe um só lugar
     que decide (`plugins/storage-postgres/src/dsn.ts`): todo parâmetro TLS é **retirado** da
     string, a política vira o objeto `ssl`, e material citado no DSN (`sslrootcert`, `sslcert`,
     `sslkey`) é lido e reentregue de propósito. O `pg_dump` recebe a mesma política pelo
     **ambiente** (`PGSSLMODE`, `PGSSLROOTCERT`, ...) e a **senha nunca vai para o `argv`**
     (`PGPASSWORD`): linha de comando é legível por qualquer usuário da máquina (`ps`).
   - **Corrida entre a checagem da trava e a abertura da unidade.** Entre ler "a trava de
     manutenção está comigo" e tomar a trava da unidade, uma restauração podia tomar a trava
     exclusiva, listar as unidades e derrubar o esquema debaixo de quem acabara de entrar. A
     sessão da unidade passa a tomar ela mesma a trava de manutenção em modo **compartilhado**,
     antes de qualquer outra coisa: é a mesma trava, então ou o escritor entra primeiro e a
     restauração é recusada, ou a restauração já está dentro e a abertura é recusada. Não há
     janela.
   - **Vazamento de conexão no worker de backup.** A conexão era aberta **antes** de reivindicar o
     arquivo de saída e fora do `try/finally`: cada tentativa que esbarrava num arquivo já
     existente deixava uma conexão pendurada pela vida do processo. Agora o arquivo vem primeiro e
     a conexão é sempre encerrada.
   - **Descritor deduzido só das linhas existentes.** Uma tabela declarada e nunca escrita, e um
     `hasGlobal` que ninguém preencheu, sumiam da cópia — a restauração devolvia uma unidade mais
     estreita do que o produto declara. A forma **declarada** passa a ser gravada com a unidade
     (`units.tables`, `units.has_global`) junto de uma **impressão digital**
     (`units.descriptor_sha256`), conferida na leitura; a cópia usa a declaração unida ao que as
     linhas mostram. Colunas anuláveis, acrescentadas com `ADD COLUMN IF NOT EXISTS`: esquema
     escrito por versão anterior continua funcionando e volta a deduzir até a unidade ser aberta
     uma vez, então a versão do layout físico não muda.
   - **Verificação de cópia carregava o arquivo inteiro na memória.** `verifyBackupFile` fazia
     `readFile`: 2 GB de cópia viravam 2 GB de memória viva, e qualquer arquivo no teto do próprio
     Node (2 GiB) não podia ser verificado de forma alguma. Agora é fluxo, com teto explícito. A
     CLI manual passou a usar o mesmo motor do worker (um domínio de cada vez, direto no arquivo) e
     aceita `--max-bytes`; `--declared-only`, que sela unidades que o meio pode nem ter, continua
     montando o pacote em memória, agora limitado pelo mesmo número.

   Cada uma dessas correções tem teste que **falha sem ela**, verificado por mutação em
   `docs/proofs/M3-postgres-hardening-proof.md`.
5. **Instância de desenvolvimento migra do `json`.** O Harness padrão guarda os
   domínios em `<DSH_HOME>/storages` (json), não em SQLite; `storage:export-json`
   cobre esse caso com o Harness parado.
6. **Gate PostgreSQL sem Docker.** `pnpm test:postgres` usa
   `DZ23_POSTGRES_TEST_DSN` quando definido (qualquer PostgreSQL 16) e só cai no
   Compose descartável sem DSN; sem servidor imprime `POSTGRES_GATE=NOT_EXECUTED`
   e falha — pular integração nunca conta como aprovado.
7. **Saídas compiladas não são versionadas.** `plugins/*/lib` saiu do Git (havia
   cópias defasadas do código-fonte que o runtime carregava); toda prova de
   runtime roda depois de `pnpm build`.

## Consequências

- Provas: `prove:postgres-runtime` (21 unidades no esquema), `prove:postgres-soak`
  (operação contínua com backups a quente, contenda de escritor e `SIGKILL`),
  `prove:storage-migration` (json → PostgreSQL com dados das fatias 1–2).
- O que ainda falta (matriz, coluna "falta para estável"): Compose real executado num servidor (o
  ambiente do Claude não tem Docker: `NOT_EXECUTED` até o Codex rodar no WSL),
  restauração ensaiada em produção, observabilidade do lease e do backup na
  interface, RLS por tenant (segue `NOT_PRESENT`, ADR própria).
