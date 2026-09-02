# P29-B — Prova de tenancy e RBAC

- Data: 2026-09-02
- Branch: `codex/p29b-tenancy-rbac`
- Base integrada: `7eedf45fe4763a21879e2fa8eba9e62417357834`
- Upstream: `6c705be1ce6774a000d061da41d1823b03a3d42c`
- Ambiente canônico: WSL2/ext4 em
  `/home/leandro/dz23-studio-p29b-verify-20260902a`

## Resultado

**GO para P29-B.** O núcleo agora possui organização, workspace, vínculos,
convites, papéis, escopo no policy engine e contratos estruturais de rota. Isso
não conclui o trust plane: a borda global P29-C continua pendente e bind público
permanece proibido.

Implementado e provado:

- bootstrap idempotente de organização, workspace e proprietário;
- papéis `owner`, `admin`, `builder` e `viewer`, sem billing;
- convite de 72 horas, token opaco hasheado, e-mail correspondente, uso único,
  revogação do convite anterior e exclusão mútua contra corrida;
- último proprietário protegido e limites de atribuição de papel;
- leitura filtrada por vínculo e recusa sem vazamento de workspace alheio;
- policy fail-closed para ferramenta sem permissão/vínculo e para escopo cruzado;
- seis rotas de tenancy e treze de identidade ligadas a contratos validados;
- auditoria de convite, aceite, mudança de papel e criação de workspace.

## Verificações reais

Em clone limpo no ext4:

- `pnpm typecheck`: PASS;
- `pnpm build`: PASS;
- `pnpm test:coverage`: 133/133 PASS;
- statements, branches, functions e lines: 100%;
- `pnpm prove:runtime`: GO em duas execuções consecutivas;
- proprietário criado, segundo usuário convidado como `builder`, convite aceito
  pela identidade autenticada, vínculo restaurado após reinício;
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

Nenhum push, PR, deploy, bind público ou mudança de licença faz parte desta
prova.
