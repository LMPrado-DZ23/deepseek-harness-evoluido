# ADR-012 — Caddy como borda única autenticada

- Estado: Aceita
- Data: 2026-09-02
- Ressalva: provada em ambiente efemero

## Contexto

O WebServer do Harness fixado não oferece um interceptor global externo. Proteger
somente as APIs do Studio deixaria a interface, os assets, o RPC e o WebSocket
nativos fora da mesma política. A investigação M73 também confirmou que a sessão
de navegador nativa é autenticada por processo/autoridade, sem identidade DZ23.

## Decisão

O Caddy é a única borda. O processo do Harness sempre escuta em `127.0.0.1`; sua
porta `3210` não é publicada. No Compose, o serviço Harness compartilha o
namespace de rede do Caddy para que ambos vejam o mesmo loopback. Somente o
serviço Caddy publica 80/443, e somente o processo Caddy escuta nessas portas.

Somente a superfície do Studio (`/studio`, `/studio/*` e `/api/studio/*`) passa
por `forward_auth` em `GET /api/studio/identity/session`. Permanecem públicas
apenas:

- `/api/studio/identity/magic/*`;
- `/api/studio/identity/passkey/login/*`;
- `/login` e `/assets/login/*`;
- `/healthz`.

Não há Basic Auth nem outra exceção implícita. O subpedido de autenticação remove
`Connection` e `Upgrade`. Qualquer rota restante, inclusive a raiz, RPCs,
`/api/session/*` e o mux WebSocket `/api/remote.mux`, recebe 404. O perfil servidor
não expõe o cliente nativo do Harness.

O Caddy sobrescreve `X-DZ23-Edge` com o valor de `DZ23_EDGE_SECRET`. A configuração
do plugin contém apenas `edge.secretRef`; o segredo é resolvido novamente a cada
requisição. O proxy reverso do Caddy gera os cabeçalhos `X-Forwarded-For`,
`X-Forwarded-Host` e `X-Forwarded-Proto` e, por padrão, ignora valores recebidos
do cliente para impedir falsificação. `edge.required` vale `false` somente no
modo pessoal em loopback e
`true` no modo servidor. Não é permitido desligá-lo em bind `0.0.0.0`. Quando a
borda é exigida, o modo pessoal implícito também é desligado, mesmo que o processo
esteja em loopback atrás do sidecar.

Depois do login DZ23, o navegador segue para `/studio/`. No perfil servidor,
`/api/studio/identity/harness/session` responde 403 e nunca emite o cookie nativo
do Harness. A troca nativa permanece disponível apenas na instalação pessoal em
loopback, com uma única pessoa cadastrada. A razão e a evidência estão na
ADR-038-assistant-multiuser-boundary.

O primeiro proprietário nunca é escolhido por corrida pública. Em instalação de
servidor, `DZ23_BOOTSTRAP_OWNER_EMAIL` é obrigatório e o enrollment usa o modo
`bootstrap-email`. Enquanto não existe usuário, somente esse e-mail normalizado
recebe código e pode se tornar `bootstrap_owner`; qualquer outro endereço recebe
a mesma resposta genérica, sem envio nem criação. Depois do primeiro cadastro, o
enrollment se fecha. Quando `edge.required=true`, o modo pessoal é desativado no
serviço de identidade e na camada HTTP, mesmo com o Harness em loopback.

Os limites são aplicados em duas camadas:

| Escopo | Limite |
| --- | ---: |
| global por IP/sessão | 300 por minuto |
| solicitar código | 5 a cada 15 minutos |
| verificar código | 10 por minuto |
| passkeys | 20 por minuto |

A camada do Caddy usa `caddy-ratelimit` fixado no commit
`5625512f24f6f59d6f64fb3aafe5eecff0b286db`; ele não é módulo oficial do Caddy.
A aplicação usa janela deslizante em memória. Multi-instância exigirá um
armazenamento atômico compartilhado; até lá, o limite da borda é a autoridade
global e o da aplicação é defesa em profundidade. Rotas públicas de login usam
o IP confiável, nunca um cookie apresentado pelo cliente; depois da autenticação,
rotas protegidas podem usar a sessão opaca como chave.

## TLS e headers

Servidor usa ACME automático e HSTS. O perfil local usa HTTP em domínio
`.localhost`, sem CA própria e sem instalar certificado no host. CSP não admite
`unsafe-eval` nem scripts/estilos inline; o artefato React fixado foi inspecionado
e suas referências são externas. Também são enviados `frame-ancestors 'none'`,
`X-Frame-Options: DENY`, `nosniff`, Permissions Policy e
`Referrer-Policy: strict-origin-when-cross-origin`.

## Evidência e limites

O P29-C original provou a borda anterior com Harness real e Caddy sem privilégios.
M73 alterou deliberadamente essa superfície: o gate agora exige 401/200 somente
para o Studio, 403 na troca de cookie nativo e 404 para raiz, API, RPC e WebSocket
do Harness. A configuração e as negativas são cobertas sem Docker; a repetição
física do `pnpm prove:edge` permanece necessária antes de promover a borda M73.

Isso autoriza a capacidade como BETA, não como produção pronta. Ainda não foram
executados: ACME num domínio real, aparelho físico, Tailscale, instalação da imagem
final do Studio ou teste de navegador completo da CSP.

Se outro proxy ficar à frente do Caddy, seus CIDRs precisam ser configurados
explicitamente em `trusted_proxies`; até isso ser testado, um proxy compartilhado
pode fazer usuários dividirem o mesmo limite por IP. `includeSubDomains` no HSTS
do servidor também exige que todos os subdomínios do operador estejam prontos para
HTTPS. A CSP mantém `ws:`/`wss:` até um E2E de navegador provar que somente
`'self'` preserva o cliente real; ela não autoriza conexão sem a autenticação da
borda.
