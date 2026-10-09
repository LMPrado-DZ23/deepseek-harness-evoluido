# P29-B — Prova de tenancy e RBAC

- Data: 2026-09-02
- Branch: `codex/p29b-tenancy-rbac`
- Base integrada: `7eedf45fe4763a21879e2fa8eba9e62417357834`
- Upstream: `6c705be1ce6774a000d061da41d1823b03a3d42c`
- Ambiente canônico: WSL2/ext4 em
  `/home/leandro/dz23-studio-p29b-verify-20260902a`

## Resultado

**GO para o candidato corrigido de P29-B.** O núcleo agora possui organização, workspace, vínculos,
convites, papéis, escopo no policy engine e contratos estruturais de rota. Isso
não conclui o trust plane: a borda global P29-C continua pendente e bind público
permanece proibido.

O commit inicial `7a7e1116ef92bde55c7baf4c40f505bd50dabd83`
recebeu NO-GO na revisão independente por conter uma segunda autoridade de
papel em `IdentityUser`, aceitar associação incompatível com a sessão mono-org,
permitir workspace criado por admin sem proprietário e não revalidar todas as
invariáveis no aceite concorrente. Os quatro cenários foram primeiro
reproduzidos como testes falhando (4 falhas, 8 aprovações) e só então
corrigidos.

Uma segunda revisão adversarial do candidato encontrou dois caminhos residuais:
promoção automática de um único registro legado ambíguo e publicação do
workspace antes da gravação do owner. A promoção automática foi removida
(estado legado sem procedência agora falha fechado) e a ordem de persistência
foi invertida para nunca expor workspace ativo sem owner. Atomicidade total e
concorrência entre processos continuam explicitamente não provadas.

Implementado e provado:

- bootstrap idempotente por procedência explícita, sem papel de autorização em
  `IdentityUser`; `Membership` é a única autoridade de papel;
- papéis `owner`, `admin`, `builder` e `viewer`, sem billing;
- convite de 72 horas, token opaco hasheado, e-mail correspondente, uso único,
  revogação do convite anterior e exclusão mútua contra corrida;
- último proprietário protegido contra rebaixamento e limites de atribuição de
  papel;
- somente proprietário cria workspace na v1.0, e o novo workspace nasce com
  proprietário;
- aceite recusado para organização divergente, workspace arquivado ou vínculo
  existente, com serialização entre tokens dirigidos ao mesmo vínculo;
- leitura filtrada por vínculo e recusa sem vazamento de workspace alheio;
- policy fail-closed para ferramenta sem permissão/vínculo e para escopo cruzado;
- seis rotas de tenancy e treze de identidade ligadas a contratos validados;
- auditoria de convite, aceite, mudança de papel e criação de workspace.

## Verificações reais

Na validação do candidato corrigido em clone descartável no ext4:

- `pnpm typecheck`: PASS;
- `pnpm build`: PASS;
- `pnpm test:coverage`: 141/141 PASS;
- statements, branches, functions e lines: 100%;
- `pnpm prove:runtime`: GO;
- proprietário criado, segundo usuário convidado como `builder`, convite aceito
  pela identidade autenticada, vínculo restaurado após reinício;
- usuário convidado como `owner` permaneceu sem autorização antes do aceite,
  inclusive após reinício;
- autorização em outra organização: negada;
- token do convite ausente do registro persistível retornado;
- sessão revogada continuou bloqueando a chamada seguinte;
- sandbox Bubblewrap continuou permitindo escrita interna e negando a externa.

## Estados verdadeiros

- núcleo org/workspace/membership/RBAC: `PASS`;
- isolamento adversarial em testes e prova viva: `PASS`;
- envio SMTP real: `NOT_CONFIGURED`;
- interface de administração para pessoas leigas: `NOT_PRESENT`;
- cerimônia WebAuthn em navegador/dispositivo físico: `NOT_EXECUTED`;
- proteção de todas as rotas em exposição pública: `BLOCKED` até P29-C;
- domínio persistente de projetos: `NOT_PRESENT`.
- atomicidade entre múltiplos processos/instâncias: `NOT_PROVEN`; exige
  transação/índice único ou compare-and-swap no backend persistente;
- migração automática de identidade legada sem procedência de bootstrap:
  `BLOCKED`; exige procedimento administrativo explícito;
- remoção de membros e proteção do último owner nessa rota futura:
  `NOT_PRESENT`.

Nenhum push, PR, deploy, bind público ou mudança de licença faz parte desta
prova.
