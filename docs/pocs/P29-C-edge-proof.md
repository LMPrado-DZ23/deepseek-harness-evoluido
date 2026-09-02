# P29-C — Prova da borda autenticada

- Data: 2026-09-02
- Ambiente: WSL2, ext4 em `/home/leandro/dz23-studio-p29c-work`
- Upstream: `6c705be1ce6774a000d061da41d1823b03a3d42c`
- Caddy: `2.11.4`
- `caddy-ratelimit`: `5625512f24f6f59d6f64fb3aafe5eecff0b286db`

## Resultado

**GO para a capacidade BETA de acesso autenticado pela borda.** Não é autorização
de deploy em produção.

| Prova real | Sem sessão | Com sessão |
| --- | ---: | ---: |
| `/` | 401 | 200 |
| `/assets/index-D-eoFxDP.js` | 401 | 200 |
| `/api/edge-proof` pelo carrier HTTP real | 401 | 200 |
| `/edge-proof/ping` pelo RPC real | 401 | 200 |
| `/api/remote.mux` WebSocket real | 401 | 101 |

Também passaram:

- troca autenticada entre sessão DZ23 e cookie nativo do Harness;
- concorrente de bootstrap recebe 202 genérico, mas nenhum código ou usuário;
- somente o e-mail configurado recebe código e se torna `bootstrap_owner`;
- sessão revogada produz 401 na requisição seguinte;
- acesso direto no host produz 401 por `edge.required`;
- contêiner externo recebe conexão recusada na porta loopback do Harness;
- Caddy produz 429 e volta a 200 depois da janela no perfil de teste;
- headers de segurança presentes e HSTS ausente no modo HTTP de teste;
- Caddy sem `--privileged`, com `CapDrop=ALL` e sem `NET_ADMIN`;
- cliente React fixado sem script ou estilo inline incompatível com a CSP;
- 149 testes dos pacotes Studio e 100% de statements, branches, functions e lines.

Após a revisão independente, o enrollment de servidor passou a aceitar somente
o e-mail obrigatório de bootstrap e o modo pessoal foi desativado também no
serviço quando a borda é exigida. O gate de correção comprova dois e-mails
concorrentes: somente o configurado recebe código e se torna proprietário.

O endpoint `/api/edge-proof` e o canal `/edge-proof` existem somente durante a
prova e são registrados no carrier do processo em execução; não entram no produto.
Os limites reduzidos de 2 eventos/1 segundo existem somente na segunda instância
efêmera do teste para provar bloqueio e liberação. Os defaults versionados continuam
300/min, 5/15min, 10/min e 20/min.

## O que não foi executado

- emissão ACME em domínio real: `NOT_EXECUTED`;
- acesso por celular físico e Tailscale: `NOT_EXECUTED`;
- confiança manual da CA local: `NOT_EXECUTED` e nunca automatizada;
- teste E2E em navegador da aplicação completa sob CSP: `NOT_EXECUTED`;
- imagem distribuível do Harness + Studio: `NOT_PRESENT`;
- deploy: `NOT_EXECUTED`.
