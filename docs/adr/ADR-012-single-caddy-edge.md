# ADR-012 — Caddy como borda única autenticada

- Status: Aceito e provado em ambiente efêmero
- Data: 2026-09-02

## Contexto

O WebServer do Harness fixado não oferece um interceptor global externo. Proteger
somente as APIs do Studio deixaria a interface, os assets, o RPC e o WebSocket
nativos fora da mesma política. Além disso, o Harness mantém uma sessão nativa
própria, necessária para suas rotas internas.

## Decisão

O Caddy é a única borda. O processo do Harness sempre escuta em `127.0.0.1`; sua
porta `3210` não é publicada. No Compose, o serviço Harness compartilha o
namespace de rede do Caddy para que ambos vejam o mesmo loopback. Somente o
serviço Caddy publica 80/443, e somente o processo Caddy escuta nessas portas.

Toda rota passa por `forward_auth` em
`GET /api/studio/identity/session`, exceto:

- `/api/studio/identity/magic/*`;
- `/api/studio/identity/passkey/login/*`;
- `/login` e `/assets/login/*`;
- `/healthz`.

Não há Basic Auth nem outra exceção implícita. O subpedido de autenticação remove
`Connection` e `Upgrade`; depois da autorização, o proxy normal preserva o
upgrade do WebSocket.

O Caddy sobrescreve `X-DZ23-Edge` com o valor de `DZ23_EDGE_SECRET`. A configuração
do plugin contém apenas `edge.secretRef`; o segredo é resolvido novamente a cada
requisição. O proxy reverso do Caddy gera os cabeçalhos `X-Forwarded-For`,
`X-Forwarded-Host` e `X-Forwarded-Proto` e, por padrão, ignora valores recebidos
do cliente para impedir falsificação. `edge.required` vale `false` somente no
modo pessoal em loopback e
`true` no modo servidor. Não é permitido desligá-lo em bind `0.0.0.0`. Quando a
borda é exigida, o modo pessoal implícito também é desligado, mesmo que o processo
esteja em loopback atrás do sidecar.

Depois do login DZ23, `/api/studio/identity/harness/session` autentica a sessão e
redireciona uma única vez para o mecanismo oficial de troca do Harness. O navegador
passa a carregar os dois cookies HttpOnly. Isso preserva a autenticação nativa sem
alterar o upstream.

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

Servidor usa ACME automático e HSTS. O perfil local usa `tls internal`, grava sua
CA apenas no volume do Caddy e nunca instala certificado no host. CSP não admite
`unsafe-eval` nem scripts/estilos inline; o artefato React fixado foi inspecionado
e suas referências são externas. Também são enviados `frame-ancestors 'none'`,
`X-Frame-Options: DENY`, `nosniff`, Permissions Policy e
`Referrer-Policy: strict-origin-when-cross-origin`.

## Evidência e limites

`pnpm prove:edge` subiu o Harness real e a imagem Caddy sem privilégios em portas
efêmeras. Provou 401/200 para raiz, asset e conexão HTTP, 401/200 para RPC e
401/101 para WebSocket; revogação imediata; 429 e liberação; cabeçalhos; e recusa
da porta interna a um contêiner externo.

Isso autoriza a capacidade como BETA, não como produção pronta. Ainda não foram
executados: ACME num domínio real, aparelho físico, Tailscale, instalação da imagem
final do Studio ou teste de navegador completo da CSP.
