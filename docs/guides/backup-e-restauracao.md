# Cópia de segurança e restauração do DZ23 STUDIO

Este guia é para quem opera o Studio em um servidor com PostgreSQL. Ele não
usa jargão além do necessário; cada comando diz o que faz.

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
pnpm storage:backup-postgres --dsn-ref DZ23_POSTGRES_DSN --schema dz23_storage --out /caminho/seguro --write
```

Sem `--write` o comando só mostra o que copiaria. O endereço do banco vem da
variável `DZ23_POSTGRES_DSN`; nunca é escrito na linha de comando.

Os dois modos do comando não funcionam do mesmo jeito, e a diferença importa em
banco grande:

- **Com `--write`** a cópia manual usa o mesmo motor da cópia automática: um
  conjunto de dados de cada vez, escrito direto no arquivo, com o mesmo teto de
  tamanho (64 MiB; `--max-bytes` só pode reduzir esse teto). Se passar do teto, a tentativa
  falha e o arquivo pela metade é apagado — nunca enche o disco em silêncio.
- **Sem `--write`** (o padrão) o comando só mostra o que copiaria, mas para
  contar os registros ele monta o pacote **inteiro na memória** e não escreve
  arquivo nenhum. Aqui o `--max-bytes` não vale para nada: não há teto nesse
  caminho. Num banco muito grande a prévia pode ficar sem memória — `NOT_VALIDATED`
  para bancos muito grandes (`docs/proofs/M3-postgres-hardening-proof.md`). Se isso
  acontecer, rode direto com `--write`, que é o caminho com teto.

## Conferir uma cópia

```
sha256sum -c studio-backup-<data-e-hora>.json.sha256
```

Se a resposta for `OK`, o arquivo está íntegro. A verificação feita pelo próprio
Studio lê o arquivo **em fluxo**, sem carregá-lo inteiro na memória, e recusa
arquivos acima do teto configurado: conferir uma cópia grande nunca custa a
memória do servidor.

## Restaurar

1. Pare o Studio. A restauração recusa continuar enquanto ele estiver ligado.
   Fora do contêiner oficial, defina `DZ23_OPERATOR_STATE_DIR` para um diretório
   privado e persistente desta instalação. No Compose oficial ele já é
   `/var/lib/dz23-studio/operator`; é ali que a retomada segura registra cada
   `attempt-id`, sem guardar DSN ou senha.
2. Veja o que será feito, sem mudar nada:
   ```
   pnpm storage:import-postgres --input studio-backup-<data-e-hora>.json --attempt-id restauracao-20260904-01 --dsn-ref DZ23_POSTGRES_DSN --schema dz23_storage --ssl verify-full
   ```
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
4. Ligue o Studio.
   Esse lançador verifica se o Harness estava ligado, espera o PostgreSQL,
   para o Harness, executa o contêiner `operator` uma única vez e só reabre os
   escritores depois que a restauração e a readiness terminarem com sucesso.
   Se a restauração falhar, o Harness permanece parado para não escrever sobre
   um estado incerto.

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

Se algo falhar no meio, o esquema temporário usado para preparar a restauração
é removido: o banco não fica com pedaços soltos.

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
