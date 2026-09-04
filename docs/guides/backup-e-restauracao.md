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
