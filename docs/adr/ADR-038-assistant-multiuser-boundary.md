# ADR-038 — Fronteira multiusuário do Assistente

Status: aceito como bloqueio fail-closed em M73.

## Problema

O chat oficial do Harness funciona em uma instalação pessoal, mas a sua
autenticação de navegador não representa uma pessoa, organização ou tenant do
DZ23 STUDIO. Expor o mesmo processo a uma equipe permitiria listar e endereçar
conversas de outras pessoas.

## Evidências no upstream fixado

- `BrowserAuth` assina apenas autoridade, emissão e expiração no cookie do
  processo;
- `session/list` chama `sessionQuery.listSessions()` e devolve todas as sessões
  visíveis do processo;
- `session/page`, `session/follow`, `session/prompt` e `session/fork` recebem um
  `sessionId`, mas nenhum principal DZ23;
- o mux `/api/remote.mux` valida o mesmo cookie do processo e descarta a
  requisição HTTP antes de abrir os streams lógicos;
- `connection.fetch.register` consegue substituir endpoints HTTP exatos, mas
  não oferece um interceptor equivalente para cada frame do mux WebSocket.

Logo, filtrar apenas `session/list` não resolveria: um identificador obtido por
log, histórico do navegador ou tentativa direta ainda alcançaria leitura,
streaming e mutações.

## Decisão

O cliente oficial do Harness é permitido somente quando o serviço de identidade
está em modo local e há exatamente uma pessoa cadastrada. O launcher valida essa
condição antes de criar ou adotar uma sessão. A rota de troca do cookie repete a
mesma validação.

No perfil Caddy/servidor:

- o login termina em `/studio/`, nunca na troca do cookie nativo;
- somente `/studio`, `/studio/*` e `/api/studio/*` são encaminhados depois de
  `forward_auth`;
- raiz, assets nativos, RPCs, `/api/session/*` e `/api/remote.mux` recebem 404;
- a própria aplicação responde 403 à troca do cookie, mesmo se alguém alcançar
  diretamente a porta interna com o segredo da borda.

Não foi alterada nenhuma linha do upstream.

## Próxima arquitetura compatível

O modo equipe só poderá conversar quando uma destas opções for provada:

1. transporte e interface do Studio que autorizem lista, histórico, prompt,
   cancelamento, anexos, aprovações e streaming por identidade; ou
2. um runtime Harness isolado por pessoa/tenant, com lifecycle, limites e
   roteamento autenticado próprios; ou
3. contrato upstream que carregue um principal verificável em todos os Remotes
   e streams.

Até lá, “conversa multiusuário” permanece `NOT_SUPPORTED`. O bloqueio não deve
ser removido por uma flag de interface: a fronteira precisa existir no servidor
e na borda.
