# ADR-023 — Camada de dados SQLite gerada pelo Studio

Status: aceita e implementada no bloco 4 da fatia 2.

Aplicativos gerados que possuem entidades de banco usam `node:sqlite` do Node
22, sem ORM e sem módulo nativo adicional. O arquivo fica em `DATA_DIR` (ou
`./data` no uso local). O Studio gera de forma determinística o esquema Zod,
SQL, migrações e um repositório tipado por entidade; o modelo de linguagem não
escreve nem altera esses arquivos.

No Linux, o diretório de dados é restringido a `0700` e o arquivo SQLite a
`0600`, mesmo quando já existem. Isso reduz exposição acidental por permissões
do sistema; não substitui criptografia de disco do equipamento.

São aceitos os tipos texto, número, data, booleano, e-mail, telefone, seleção e
referência. Nomes de tabela e coluna são normalizados e colisões são recusadas.
Toda tabela possui `id`, `created_at` e `updated_at`; referências usam chave
estrangeira. O boot aplica `foreign_keys=ON`, `journal_mode=WAL` e migrações
idempotentes versionadas por `PRAGMA user_version`.

Entidades marcadas como sensíveis só são geradas após confirmação registrada
na AppSpec. O contrato gerado marca `sensitive`, `requires_login` e
`public_list`; a autenticação do ADR-024 faz cumprir o acesso nos formulários
sensíveis e em todo painel CRUD. Não há rota pública de dados nesta fatia.

Arquivos em `src/db/**`, `src/server/repositories/**` e o teste de dados gerado
são gravados antes da saída do modelo e entram na lista protegida. Um parser
TypeScript examina imports estáticos, reexports, `require` e `import()`; somente
facades públicas de repositório, componentes de UI, utilitários aprovados e
outros arquivos da própria saída são aceitos. Violação termina em
`GENERATED_FILE_REJECTED`.

A prova executável usa o template Next.js e a imagem fixada do construtor com
rede desativada. Ela executa migração duas vezes, inserção, listagem,
atualização e exclusão reais em SQLite, além de build, Vitest e Playwright.
PostgreSQL para o aplicativo gerado permanece uma alternativa futura de
staging e não muda o contrato público dos repositórios.
