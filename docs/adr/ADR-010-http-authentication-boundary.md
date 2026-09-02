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
declarado como concluído. Ele será satisfeito em P29-C por Caddy como borda única,
mantendo o Harness em `127.0.0.1`, ou por um seam de middleware aceito pelo
upstream. Até lá, exposição pública é proibida.

Rate limiting global e headers de borda também pertencem a P29-C. Esta separação
preserva zero diff no upstream e mantém o risco visível.
