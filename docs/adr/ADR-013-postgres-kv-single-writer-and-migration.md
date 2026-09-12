# ADR-013 — PostgreSQL para domínios Studio, escritor único e migração verificável

- Estado: Aceita
- Data: 2026-09-02
- Ressalva: para P31-A BETA

## Decisão

O DZ23 STUDIO registra `@dz23-studio/storage-postgres` como backend `postgres`
pelos seams públicos do Harness. No perfil de servidor, somente os nove domínios
físicos `studio_*` são roteados a ele. O backend padrão continua `json`; sessões,
logs e domínios oficiais do Harness não mudam de mídia.

O nome configurável do schema é limitado a 40 caracteres ASCII válidos. Isso
reserva espaço para o sufixo de staging sem depender do truncamento silencioso de
identificadores que o PostgreSQL aplica depois de 63 bytes.

A DSN nunca entra no YAML. `dsnRef` contém apenas o nome POSIX de uma credencial e
o valor é resolvido por `ctx.credentials`. O schema físico é dedicado,
`dz23_storage`, e a imagem de teste/servidor é PostgreSQL 16 fixada por digest.

Cada unidade aberta usa uma conexão física dedicada. Essa mesma conexão:

1. adquire `pg_try_advisory_lock(hashtext(...))`;
2. mantém a trava durante todas as leituras e escritas daquela unidade;
3. atualiza uma linha de heartbeat a cada 15 segundos;
4. rejeita operações com `StudioStorageError`, código runtime `unit-locked`, se a
   conexão ou a trava for perdida;
5. libera a trava ao fechar ou pela própria sessão PostgreSQL ao morrer.

O advisory lock é a autoridade. Heartbeat antigo é apenas diagnóstico e jamais
autoriza takeover enquanto a trava real estiver ocupada. Um novo escritor só
entra depois de adquirir a mesma trava. O pool de no máximo quatro conexões serve
bootstrap e saúde; cada domínio aberto acrescenta uma conexão dedicada para não
devolver a trava ao pool por engano.

## Layout

O schema contém versão física, versões por unidade, uma tabela normalizada de
registros JSONB com chave `(unit, table_name, key)`, singleton global e leases.
Não são criadas tabelas `u_<unit>_<table>`: a gramática upstream não limita o
tamanho dos segmentos, enquanto o PostgreSQL trunca identificadores acima de 63
bytes e poderia colidir duas declarações válidas. A tabela normalizada elimina
identificadores derivados sem alterar a semântica do KV. Cada primitiva é uma
instrução SQL atômica. `loadAll` usa uma única instrução para obter registros e
global no mesmo snapshot da instrução. Valores e chaves continuam opacos.

## Escopo de tenant

O gate `pnpm gate:domain-scopes` descobre toda declaração `defineDomain` no código
Studio e exige classificação explícita de cada tabela. Não há wildcard. As
exceções atuais são deliberadas e testadas:

- `studio_hello.records`: somente `tenant_id`, por ser domínio histórico do PoC;
- credenciais e desafios: `user_id`, pois a passkey pertence à pessoa;
- organizações: somente `org_id`, pois são a raiz;
- workspaces, memberships e invitations: `workspace_id` é a chave de tenant do
  modelo, sempre acompanhada de `org_id`.

Isso é um gate de modelo e aplicação, não RLS do PostgreSQL. O KV upstream trata
o valor como JSON opaco e carrega o domínio inteiro na memória; portanto não há
como aplicar `SET LOCAL`, `USING/WITH CHECK` ou contexto por requisição sem mudar
o contrato público. A prova adversarial demonstra que o serviço de tenancy não
retorna a organização B ao ator A, mas não será anunciada como isolamento RLS.

## Migração e rollback

A exportação é lógica e versionada: snapshot SQLite consistente por `VACUUM INTO`,
descritor de cada domínio conhecido, pin do Harness, contagens e SHA-256 por
domínio e do payload inteiro. O comando é dry-run por padrão e exige
`--confirm-harness-stopped`; não copia um arquivo WAL vivo.

A importação valida tudo antes de escrever, importa para schema de staging vazio,
reabre e compara checksums, exige `pg_dump` e caminho de backup no modo `--write`
e só então troca o schema numa transação. Alvo ocupado falha; substituição exige
simultaneamente `--force --confirm REPLACE_DZ23_STORAGE`. Não existe merge/upsert
silencioso.

Antes do backup e do cutover, a CLI tenta adquirir na própria conexão as mesmas
advisory locks de cada unidade do bundle. Qualquer trava ocupada aborta a
importação com instrução para parar o Studio; as travas já adquiridas permanecem
até o fim da conexão. Se o schema ainda não existe, `pg_dump` é dispensado e o
relatório marca `not-needed-empty-target`. Se existe, o dump é obrigatório,
exclusivo, modo `0600` e nunca sobrescreve arquivo anterior.

O perfil atual do Studio herda `storage-json`, não SQLite. Assim, a ferramenta
SQLite serve instalações que realmente usaram esse backend; ela não é apresentada
como migração do estado atual nem inclui sessões JSONL.

## Limites obrigatórios

- Estado: BETA. Não houve domínio real, servidor público nem carga prolongada.
- Um escritor por unidade não equivale a ativo/ativo. Um segundo processo falha
  fechado; ele não funciona como standby quente.
- `storage-domain` mantém estado autoritativo em memória. Após perda de lock, o
  processo deve encerrar e reiniciar antes de servir novamente.
- O contrato KV não oferece CAS, batch ou transação entre unidades/registros.
  `createWorkspace` e `acceptInvitation` continuam operações compostas do serviço;
  PostgreSQL não as torna transacionais automaticamente.
- RLS estrutural, runtime role sem `BYPASSRLS` e repositórios tenant-aware ficam
  `NOT_PRESENT` até um contrato novo, sem alegação de multi-instância completa.

## Provas exigidas para promover

Antes de ESTÁVEL: extensão transacional/tenant-aware aprovada, reload seguro após
takeover, RLS real com papel não-owner, backup e restore real, teste de carga,
observabilidade e prova de servidor/celular. Nenhum desses itens é inferido deste
PoC.
