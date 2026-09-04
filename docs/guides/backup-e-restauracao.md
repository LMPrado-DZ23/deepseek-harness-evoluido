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

A cópia é feita por um **programa separado**, não pelo Studio em si: assim,
por maior que fique o banco, copiar nunca deixa o Studio lento nem o derruba.
Esse programa tem hora para acabar (15 minutos), tamanho máximo de arquivo
(2 GB) e memória própria; se estourar qualquer um dos três, a tentativa é
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

## Conferir uma cópia

```
sha256sum -c studio-backup-<data-e-hora>.json.sha256
```

Se a resposta for `OK`, o arquivo está íntegro.

## Restaurar

1. Pare o Studio. A restauração recusa continuar enquanto ele estiver ligado.
2. Veja o que será feito, sem mudar nada:
   ```
   pnpm storage:import-postgres --input studio-backup-<data-e-hora>.json --dsn-ref DZ23_POSTGRES_DSN --schema dz23_storage --ssl verify-full
   ```
3. Restaure de verdade. Se o banco já tiver dados, o comando exige que você
   confirme a substituição e guarda antes uma cópia física do que existia:
   ```
   pnpm storage:import-postgres --input studio-backup-<data-e-hora>.json --dsn-ref DZ23_POSTGRES_DSN --schema dz23_storage --ssl verify-full --write --backup /caminho/seguro/antes-de-restaurar.dump --force --confirm REPLACE_DZ23_STORAGE
   ```
4. Ligue o Studio.

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
  outro sistema.

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
