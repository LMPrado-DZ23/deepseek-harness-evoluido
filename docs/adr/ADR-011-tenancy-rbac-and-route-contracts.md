# ADR-011 — Organizações, espaços de trabalho, papéis e contratos de rota

- Status: Aceito
- Data: 2026-09-02

## Contexto

O DZ23 STUDIO precisa servir uma pessoa sozinha e equipes sem permitir que um
identificador enviado pelo navegador escolha a organização autorizada. A
decisão de produto também é explícita: o sistema será open source e não terá
cobrança, assinatura, créditos ou paywall.

## Decisão

O isolamento segue `org -> workspace (tenant) -> project`. Nesta fatia,
organizações, workspaces, vínculos e convites são persistidos nos domínios
físicos `studio_orgs`, `studio_workspaces` e `studio_memberships`; os nomes
lógicos são `studio.orgs`, `studio.workspaces` e `studio.memberships`.

O primeiro usuário confirmado cria de forma idempotente sua organização, seu
workspace e um vínculo `owner`. Depois disso, novos usuários só entram por um
convite ativo. O convite guarda apenas SHA-256 do token, expira em 72 horas,
aceita uma única vez e só pode ser usado pelo e-mail autenticado ao qual foi
enviado. Organização e workspace vêm do registro do servidor, nunca do corpo
anônimo.

Papéis:

- `owner`: segurança, membros, configurações e exclusão;
- `admin`: membros, integrações e trabalho de projeto, sem promover `owner`;
- `builder`: leitura, criação/edição e publicação somente até staging;
- `viewer`: leitura e acompanhamento.

Não existe permissão de billing. Produção autônoma também não é concedida por
nenhum papel.

O policy engine recebe o vínculo persistido como autoridade de papel e escopo.
Ferramenta sem permissão declarada, sem vínculo ou com `org_id`/`tenant_id`
divergente é bloqueada por padrão. Cada rota do Studio pertence a uma lista
estrutural validada com método, caminho, nível de acesso, permissão e escopo;
rota ausente dessa lista responde 404 antes de executar a operação.

Convites, aceites, mudanças de papel e criação de workspace entram na auditoria
de identidade sem token, código ou segredo em claro. Operações concorrentes de
convite, aceite e troca de papel são serializadas por chave. O último `owner`
de um workspace não pode ser rebaixado.

## Limites

P29-B protege as rotas próprias de identidade e tenancy. A proteção de todas as
rotas nativas do Harness continua requisito do P29-C: Caddy com `forward_auth`,
Harness apenas em loopback/rede privada e teste de acesso direto recusado.
Projetos terão seu domínio persistente numa fatia posterior; as permissões já
ficam congeladas para evitar um segundo modelo de autorização.

