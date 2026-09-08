# M94 — S-09: o primeiro domínio saiu da chave-valor opaca

## O que se afirma

`studio_action_approvals` — a autoridade de confirmação, o domínio que decide se
uma ação sensível acontece — tem um caminho real para uma **tabela com
isolamento por linha (RLS)**, com backfill, verificação e volta atrás, provado
contra **PostgreSQL 16 de verdade**.

**1 de 26 domínios migrado.** Os outros 25 seguem na chave-valor opaca.

## Provas

```
POSTGRES_GATE=PASS server=preset-dsn mode=integration
Test Files 7 passed (7)   Tests 61 passed (61)
```

- `plugins/storage-postgres/tests/approval-rls-migration.postgres.spec.ts` —
  contra PostgreSQL 16.13 real, com esquema descartável e papel de runtime
  `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`.
- `plugins/storage-postgres/tests/domain-rls-migration.spec.ts` — 18 testes da
  lógica que decide o que conta como "conferiu".
- `plugins/action-approval` — 91 testes, incluindo 10 do repositório novo.
- **15 mutações, 15 mortas.**

| mutação | morta |
| --- | --- |
| verificação ignora conteúdo (só conta linhas) | sim |
| verificação ignora o que chegou a mais | sim |
| digest do conjunto ignora a chave | sim |
| digest do conjunto depende da ordem de leitura | sim |
| linha sem escopo recebe escopo padrão | sim |
| canônico não ordena as chaves | sim |
| leitura sem escopo | sim |
| escrita condicional desligada | sim |
| criação sobrescreve o que existe | sim |
| listagem ignora sessão e pessoa | sim |
| linha corrompida entra na leitura | sim |
| escrita usa escopo de fora | sim |
| RLS ausente cai calado para a chave-valor | sim |
| o padrão vira RLS | sim |
| leitura em memória atravessa o inquilino | sim |

Uma décima sexta mutação **sobreviveu** — incluir o tamanho da lista no digest
do conjunto era redundante, porque uma lista com um registro a mais já é outro
texto. O campo foi **removido** em vez de se fabricar um teste para ele.

## A mudança que importa: quem separa os inquilinos

Antes, `repository.get(approvalId)` devolvia o registro de qualquer inquilino e
o serviço comparava os campos depois. Se um dia essa comparação saísse de um
caminho, a linha do outro inquilino chegava a quem pediu.

Agora a leitura carrega o escopo — `get({orgId, tenantId}, approvalId)` — e sob
a tabela RLS quem recusa é o **banco**, dentro da mesma transação que instala
`dz23.org_id` e `dz23.tenant_id` com `set_config(..., true)`. Nenhum `if` deste
repositório precisa estar correto para o isolamento valer.

A mesma assinatura foi aplicada aos repositórios em memória e de chave-valor, e
cada um deles ganhou um teste de travessia de inquilino — o repositório em
memória é o que todas as provas do serviço usam, e um vazamento nele deixaria
essas provas verdes sobre um repositório que devolve a linha da pessoa errada.

## Backfill, verificação e volta atrás

**O plano é montado antes de qualquer escrita.** Uma linha sem `org_id`/
`tenant_id` derruba o plano inteiro com o destino ainda intocado — e não recebe
um escopo padrão, porque um escopo inventado colocaria a linha *embaixo de
alguém*. Se o escopo fosse resolvido durante a cópia, a migração pararia no meio
com metade dos registros de cada lado.

**A verificação é adversarial.** No teste real, depois do backfill uma
confirmação é alterada no destino e a verificação reprova — com os **dois lados
tendo o mesmo número de registros**. Contar linhas pega o que sumiu e não pega o
que chegou diferente; numa autoridade de confirmação, um registro diferente é
uma confirmação com outro conteúdo do que a pessoa aprovou. A comparação é
registro a registro (SHA-256 do par chave+conteúdo, JSON canônico) **mais** o
digest do conjunto: a lista de achados sozinha não pegaria uma diferença numa
chave que os dois lados não tenham em comum, e o digest sozinho não diria qual
chave está errada.

**A volta atrás é executável, não só conferível.** A chave-valor nunca é
apagada. No teste, as linhas saem da tabela, o destino fica vazio, e a
chave-valor volta a ser a autoridade já com o conteúdo mais recente
reconciliado.

## O que continua desligado, e por quê

- **Nenhuma instalação usa RLS hoje.** `storageAuthority` é `kv` por padrão e
  nenhum perfil define `tenantRuntimeDsnRef`. A migração é explícita por
  desenho: trocar a autoridade sozinho migraria dados de gente sem ninguém
  pedir.
- **Pedir `rls` sem o armazenamento por inquilino montado FALHA ALTO.** Cair de
  volta para a chave-valor em silêncio seria o pior desfecho: quem pediu RLS
  acharia que tem isolamento no banco, e os dois lados divergiriam desde o
  primeiro pedido.
- **RLS separa inquilinos; ela não cria transação.** A escrita condicional
  continua sendo leitura e escrita em duas idas ao banco, sob o mutex do
  serviço, exatamente como na chave-valor. O Studio continua escritor único.
- **O passo de OPERAÇÃO não existe.** Não há comando com credencial por
  referência para rodar o backfill numa instalação. Ele pertence ao operador
  empacotado (`apps/studio-runtime/operator.mjs`), que é o único caminho
  destrutivo do produto — e criar um segundo script com DSN e escrita seria
  abrir exatamente a porta que aquele arquivo existe para manter fechada.

## Ambiente da prova

PostgreSQL 16.13 instalado no contêiner desta sessão, com DSN presetado
(`DZ23_POSTGRES_TEST_DSN`) e `DZ23_OPERATOR_STATE_DIR` configurado — os dois
pré-requisitos que o portão exige e sem os quais ele reporta `NOT_EXECUTED` e
sai com erro, em vez de passar calado.
