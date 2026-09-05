# PostgreSQL do DZ23 STUDIO — guia simples e seguro

Este recurso guarda os dados próprios do DZ23 STUDIO num PostgreSQL. Ele ainda é
BETA. Conversas e dados internos do Harness continuam onde já estavam.

## Para testar sem instalar PostgreSQL manualmente

Com Docker funcionando:

```bash
pnpm test:postgres
```

O comando cria um banco descartável, escolhe uma porta local aleatória, executa
as provas e apaga o contêiner. A senha temporária não é mostrada.

## Para usar no servidor

Defina no gerenciador de segredos do servidor:

- `DZ23_POSTGRES_PASSWORD`: senha do usuário do banco;
- `DZ23_POSTGRES_DSN`: conexão completa usada pelo Harness;
- as variáveis já exigidas pelo Caddy, identidade e SMTP.

Não coloque a DSN em arquivos versionados. O PostgreSQL do Compose não publica
porta para a internet. Se o banco não iniciar, o Studio também não inicia: isso
evita trabalhar fingindo que os dados foram salvos.

## Exportar uma instalação SQLite

Primeiro pare o Harness. O exportador recusa continuar sem essa confirmação.
Faça uma simulação:

```bash
pnpm storage:export-sqlite -- --sqlite /caminho/studio.sqlite --out /caminho/export.json --confirm-harness-stopped
```

Se as contagens estiverem certas, repita com `--write`. O arquivo é criado com
permissão de dono e nunca sobrescreve outro arquivo.

## Importar no PostgreSQL

Pare o DZ23 STUDIO no servidor antes de importar. A ferramenta também verifica
as travas e recusa continuar se encontrar uma unidade ainda aberta.

Coloque a DSN numa variável de ambiente, por exemplo `DZ23_POSTGRES_DSN`. Nunca
passe a senha na linha de comando. Faça primeiro o dry-run:

```bash
pnpm storage:import-postgres -- --input /caminho/export.json --attempt-id restauracao-<data>-<numero> --dsn-ref DZ23_POSTGRES_DSN --schema dz23_storage --ssl verify-full
```

Para escrever, instale `pg_dump` e `pg_restore`, escolha um arquivo de backup novo e acrescente
`--attempt-id restauracao-<data>-<numero> --write --backup /caminho/antes.dump`. Use o mesmo
`attempt-id` ao retomar uma tentativa interrompida; nunca reutilize esse identificador com outra
cópia. Fora do contêiner oficial, configure também `DZ23_OPERATOR_STATE_DIR` com um diretório
privado e persistente da instalação; no Compose oficial ele já é
`/var/lib/dz23-studio/operator`. Se o alvo já tiver dados, pare e confira.
A ferramenta recusa sobrescrever um backup que já existe.
A primeira importação num servidor sem schema não cria dump, pois ainda não há
dado anterior; o relatório mostra `not-needed-empty-target`.
A substituição exige `--force --confirm REPLACE_DZ23_STORAGE` e só deve ocorrer
com janela de manutenção e Harness parado.

## O que esta fase não promete

Ela prova persistência e impede dois escritores simultâneos. Ainda não prova
alta disponibilidade, várias instâncias atendendo juntas, RLS no banco, deploy
de produção ou recuperação de desastre. Uma mensagem `unit-locked` significa:
outro processo possui a unidade, ou a conexão segura foi perdida; reinicie o
processo depois de corrigir a causa, sem forçar a trava.
