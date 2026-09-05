# Cópia de segurança e restauração do DZ23 STUDIO

Este guia é para quem opera o Studio em um servidor com PostgreSQL. Ele não
usa jargão além do necessário; cada comando diz o que faz.

Os quatro comandos operacionais (`backup`, `verify-backup`, `restore` e
`status`) têm uma única autoridade: `apps/studio-runtime/operator.mjs`, executada
no contêiner Linux temporário `operator`. O script
`pnpm storage:operator-stopped` existe somente para a restauração real: ele para
o Harness antes e só o religa depois de uma conclusão confirmada.

## O que é guardado

Tudo o que o Studio sabe sobre você fica em um banco PostgreSQL: pessoas,
sessões, organizações, espaços de trabalho, projetos, planos, verificações e
evidências. Os arquivos dos protótipos gerados ficam fora do banco, na pasta
de execuções.

## Cópia automática

Quando o Studio roda pelo `docker-compose.yml`, ele mesmo faz uma cópia
completa a cada hora e guarda as últimas 48 na pasta `studio-backups`. Cada
cópia é um arquivo `studio-backup-<data-e-hora>.json` acompanhado de um
`.sha256` que prova que o arquivo não foi alterado, e um registro
`backups.jsonl` com o resultado de cada tentativa. A cópia acontece com o
Studio ligado, sem travar ninguém.

A cópia é feita por um **programa separado**, não pelo Studio em si: assim, por maior que fique o
banco, o Studio não gasta a própria memória para copiar, e uma cópia travada não derruba o Studio.
Sendo honesto sobre o limite: a cópia lê o **mesmo banco de dados**, então pode disputar disco com
quem estiver usando o sistema naquele momento — o que ela não faz é parar o Studio.
Esse programa tem hora para acabar (15 minutos), tamanho máximo de arquivo
(64 MiB nesta versão) e memória própria; o pico de memória pode ser várias vezes maior que o
arquivo porque a validação JSON ainda cria buffer, texto e objetos, portanto **64 MiB não é um
teto de RAM**. Se estourar o tempo ou o tamanho, a tentativa é
registrada como falha, o arquivo pela metade é apagado e o Studio continua
funcionando normalmente.

Para mudar a frequência ou a quantidade guardada, defina
`DZ23_POSTGRES_BACKUP_INTERVAL_MINUTES` (mínimo 5) e
`DZ23_POSTGRES_BACKUP_KEEP` no ambiente do servidor.

Atenção: a pasta de cópias contém dados pessoais (e-mails, nomes, projetos)
e chaves de sessão em forma de resumo. Trate-a como o próprio banco: só quem
administra o servidor acessa, e a retenção segue a regra de dados do Studio.

## Cópia manual

```
docker compose --profile operator run --rm --no-deps operator backup --dsn-ref DZ23_POSTGRES_DSN --schema dz23_storage --out /var/lib/dz23-studio-backups
```

O endereço do banco vem da variável `DZ23_POSTGRES_DSN`; nunca é escrito na
linha de comando. O operador escreve primeiro o arquivo e só publica o marcador
`.sha256` depois que ambos estão duráveis. A retenção começa somente depois
desse par completo; arquivo parcial nunca conta como cópia válida.

A cópia manual usa o mesmo motor em fluxo da cópia automática: um conjunto de
dados por vez, direto no arquivo, com teto de 64 MiB. `--max-bytes` pode reduzir
esse teto, nunca aumentá-lo. Se passar do limite, a tentativa falha e o arquivo
pela metade é removido.

## Conferir uma cópia

```
sha256sum -c studio-backup-<data-e-hora>.json.sha256
```

Se a resposta for `OK`, o arquivo está íntegro. A verificação feita pelo próprio
Studio lê o arquivo **em fluxo**, sem carregá-lo inteiro na memória, e recusa
arquivos acima do teto configurado: conferir uma cópia grande nunca custa a
memória do servidor.

Para conferir também o formato, os limites e os resumos internos com a mesma
autoridade usada pela restauração:

```
docker compose --profile operator run --rm --no-deps operator verify-backup --input /var/lib/dz23-studio-backups/studio-backup-<data-e-hora>.json
```

Para consultar a saúde do armazenamento sem mostrar endereço, usuário ou senha
do banco:

```
docker compose --profile operator run --rm --no-deps operator status --dsn-ref DZ23_POSTGRES_DSN --schema dz23_storage --ssl verify-full
```

## Restaurar

### Antes de mudar qualquer coisa

Cada banco recebe uma impressão física, e cada instalação recebe um
`installation_id` lógico. A impressão física prende a tentativa ao PostgreSQL
correto; o identificador lógico acompanha a cópia e evita trocar, sem perceber,
os dados de um servidor pelos de outro. Não edite esses valores.

1. Não execute uma restauração real chamando o contêiner diretamente. Use o
   lançador do passo 3: ele para o Harness e confere o PostgreSQL. Fora do
   contêiner oficial, defina `DZ23_OPERATOR_STATE_DIR` para um diretório privado
   e persistente desta instalação. No Compose oficial ele já é
   `/var/lib/dz23-studio/operator`; é ali que a retomada segura registra cada
   `attempt-id`, sem guardar DSN ou senha.
2. Veja o que será feito, sem mudar nada:
   ```
   docker compose --profile operator run --rm --no-deps operator restore --input /var/lib/dz23-studio-backups/studio-backup-<data-e-hora>.json --attempt-id restauracao-20260904-01 --dsn-ref DZ23_POSTGRES_DSN --schema dz23_storage --ssl verify-full
   ```
   Essa prévia é pura: não cria journal, não faz `pg_dump`, não cria ou remove
   schema temporário e não troca dados. Ela informa exatamente o que seria
   perdido, objetos que não reconhece, temporários órfãos e se a cópia veio de
   outra instalação.
   O `--ssl` do comando é a **única** autoridade sobre a conexão: se o endereço do
   banco trouxer `sslmode`, `sslrootcert` ou parecidos, eles não conseguem
   enfraquecer o que você pediu. A cópia física de segurança (`pg_dump`) segue a
   mesma política, e a senha do banco vai para ela pelo ambiente — nunca pela
   linha de comando, que qualquer usuário da máquina consegue ler.
3. Restaure de verdade. Se o banco já tiver dados, o comando exige que você
   confirme a substituição e guarda antes uma cópia física do que existia:
   ```
   pnpm storage:operator-stopped -- restore --input /var/lib/dz23-studio-backups/studio-backup-<data-e-hora>.json --attempt-id restauracao-20260904-01 --dsn-ref DZ23_POSTGRES_DSN --schema dz23_storage --ssl verify-full --write --backup /var/lib/dz23-studio-backups/antes-de-restaurar.dump --force --confirm REPLACE_DZ23_STORAGE
   ```
4. Confira o resultado. Esse lançador verifica se o Harness estava ligado, espera o PostgreSQL,
   para o Harness, executa o contêiner `operator` uma única vez e só reabre os
   escritores depois que a restauração e a readiness terminarem com sucesso. Se
   o Harness já estava parado, ele continua parado até o operador decidir ligá-lo.
   Se a restauração falhar, o Harness permanece parado para não escrever sobre
   um estado incerto.

Use sempre o mesmo `--attempt-id` ao retomar a mesma restauração. O journal é
reservado de forma atômica e ligado à cópia, ao schema e ao PostgreSQL físico;
ele não serve para outra tentativa.

O formato JSON ainda precisa ser materializado para a validação estrita. Por
isso o operador recusa valores de `--max-bytes` acima de 67.108.864 bytes
(64 MiB). Esse é o teto comprovado desta versão, não uma promessa de 2 GiB.
### O que a restauração recusa fazer (e por quê)

Restaurar apaga o que está lá para colocar o que está na cópia. Por isso o
comando prefere parar do que errar — e todas essas recusas acontecem **antes**
de qualquer coisa ser apagada, inclusive antes da cópia física de segurança:

- **Studio ligado.** Enquanto o Studio estiver de pé, a restauração não começa.
  Isso vale mesmo que a cópia não mencione as partes que ele está usando no
  momento — antes essa brecha existia.
- **Cópia vazia.** Um arquivo sem nenhum conjunto de dados não restaura nada:
  só apagaria. Recusado.
- **Cópia incompleta.** Se o banco tem conjuntos de dados que a cópia não traz,
  restaurar apagaria esses conjuntos. O comando diz **quais** e para. Se for
  mesmo isso que você quer (por exemplo, voltar a um estado antigo de propósito),
  repita acrescentando `--allow-domain-loss --confirm REPLACE_DZ23_STORAGE`.
- **Menos registros dentro de um conjunto existente.** Mesmo que todos os
  conjuntos estejam presentes, a cópia pode apagar registros ou um valor
  global mais novo. Só prossiga, depois de conferir a lista, com
  `--allow-record-loss --confirm REPLACE_DZ23_STORAGE`.
- **Objetos desconhecidos.** Tabelas, funções ou outros objetos que esta versão
  não reconhece seriam apagados pela troca. Só prossiga após identificar a
  origem com `--allow-unknown-objects --confirm REPLACE_DZ23_STORAGE`.
- **Cópia de outra instalação.** Se o `installation_id` da cópia for diferente
  do destino, o operador para. Só use
  `--allow-foreign-installation --confirm REPLACE_DZ23_STORAGE` quando a troca
  de servidor for realmente intencional.
- **Esquema que não é do Studio.** Se o lugar de destino não tiver a estrutura
  do Studio, ou for de outra versão, o comando recusa em vez de apagar dados de
  outro sistema. "Tem alguma coisa dentro" é perguntado a **todos** os catálogos
  do PostgreSQL que pertencem a um esquema — inclusive configurações de busca
  textual, conversões, classes de operador e extensões, que não aparecem na
  lista de tabelas. Um esquema alheio contendo só isso já foi confundido com um
  esquema vazio.
- **Esquema de outro dono com nome parecido.** A limpeza de esquemas temporários
  esquecidos só apaga os que esta ferramenta criou e marcou como seus, e só
  quando o nome tem exatamente a forma esperada.

Cada autorização acima é independente e só funciona junto da frase exata
`--confirm REPLACE_DZ23_STORAGE`. Não copie todas as opções por hábito: leia a
prévia e libere apenas a condição que você entendeu.

Antes do `COMMIT`, se algo falhar, a troca é desfeita e o schema temporário é
removido. Depois do `COMMIT`, o banco já foi restaurado: o operador não tenta
`ROLLBACK`, não apaga o resultado e não diz que “nada mudou”. Se a gravação do
journal ou a saída do comando falhar nesse ponto, **mantenha o Harness parado**,
não comece outra restauração e reconcilie com o mesmo `attempt-id`.

Schemas temporários deixados por uma interrupção brusca são mostrados na prévia.
Na escrita, apenas temporários com nome exato e marca de propriedade do Studio
podem ser removidos; nomes parecidos de outro sistema não são tocados.

## Trazer os dados do computador de desenvolvimento

No computador, o Studio guarda tudo em arquivos na pasta `storages` dentro de
`DSH_HOME`. Com o Studio parado:

```
pnpm storage:export-json --storages ~/.dsh/storages --out dev.bundle.json --confirm-harness-stopped --write
```

O arquivo gerado é restaurado no servidor com o mesmo comando de restauração
acima.

## Prova executada

O caminho completo — cópia agendada e cópia do operador com o Studio ligado, perda do esquema,
restauração pela CLI, Studio religado com a mesma sessão e os mesmos registros, recusa de
sobrescrever um esquema povoado sem confirmação — é exercitado por `pnpm prove:backup-restore`
(PostgreSQL real). Resultado em `docs/proofs/P31-B-backup-restore-proof.md`. A prova também
mostra, sem esconder, que uma escrita feita depois da cópia não volta: a restauração é um ponto
no tempo, por isso a frequência da cópia agendada importa.

No checkpoint W3 de 05/09, os 181 testes que não dependem de Docker passaram e
59 integrações PostgreSQL/Docker foram puladas. A prova real do operador no
Docker Desktop Windows está `BLOCKED_ENVIRONMENT` por quebra do Docker Desktop
deste computador. Portanto este checkpoint não afirma que PostgreSQL/Compose
foram reexecutados; a classificação continua BETA até essa prova ocorrer.
