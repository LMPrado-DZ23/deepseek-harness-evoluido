# ADR-010 — Limite HTTP de autenticação e seam ausente no upstream

- Status: Aceito com limitação explícita
- Data: 2026-09-02

## Contexto

O `WebServer` do DeepSeek Harness fixado em
`6c705be1ce6774a000d061da41d1823b03a3d42c` permite registrar rotas exatas ou por
prefixo, mas não oferece middleware/interceptor global. Um plugin externo não
consegue envolver rotas já registradas sem alterar o upstream.

## Decisão

P29-A protege todas as rotas sob `/api/studio/identity`, valida `Host` e `Origin`
por allowlist e recusa e-mail de desenvolvimento em bind `0.0.0.0`. O Harness
permanece em loopback.

O gate “toda rota do produto exige sessão em bind público” não será falsamente
declarado como concluído. Em P29-C, o Caddy será a única borda e aplicará
`forward_auth` a **todas** as rotas, inclusive as rotas nativas do Harness. O
Harness continuará acessível apenas em loopback/rede privada de contêiner, com
firewall impedindo acesso direto. Um seam `webserver/pre-route` no upstream será
proposto separadamente, mas não será dependência do release. Até essa defesa em
profundidade ser provada, exposição pública é proibida.

Rate limiting global e headers de borda também pertencem a P29-C. Esta separação
preserva zero diff no upstream e mantém o risco visível.

## Prova exigida em P29-C

- rota do Studio sem sessão: bloqueada pelo Caddy;
- rota nativa do Harness sem sessão: bloqueada pelo Caddy;
- tentativa de acesso direto ao Harness a partir de fora da rede autorizada:
  conexão recusada;
- sessão revogada: próxima requisição bloqueada;
- rate limit e headers de segurança verificados na borda.

O texto proposto para a issue upstream está em
`docs/upstream/webserver-pre-route-issue-draft.md` e não foi publicado.
