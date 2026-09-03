# Handoff Claude × Codex — preparação da fase 0.5

## Estado

- base: `codex/p30-policy-foundation@dc1b0f82438db76555d9daa880f748f557d59128`;
- branch do kit: `codex/p05-usability-kit`;
- worktree: `C:\Users\zodyp\Documents\Codex\2026-09-01\com\work\p05-usability-kit`;
- OmniSeek P40 separado: `codex/p40-prototype-hardening@d9a8109528839a9f6c691cab9d71f3fce7e91e02`;
- fase humana: `NOT_EXECUTED`;
- preflight atual: `BLOCKED_LOCAL_AI` — a porta 8000 responde com uma página de
  login, não com uma lista OpenAI-compatible de modelos;
- P32/P31-B: bloqueados até `GO` da fase 0.5.

## Decisão de empacotamento

O ZIP do kit não inclui código, wheel nem dependências do OmniSeek. Isso mantém
a decisão P39: OmniSeek é protótipo separado para pesquisa e referência, nunca
parte do artefato do DZ23 STUDIO. O lançador exige o checkout P40 exato e limpo.

## Conteúdo produzido

- roteiro único para o participante;
- protocolo completo do facilitador;
- formulário de observação por sessão;
- scorecard objetivo de saída;
- lançador WSL2 com fail-closed para commit, árvore suja, Docker, Python, IA
  local, porta e isolamento por participante;
- empacotador que gera ZIP, manifesto e SHA-256 sem transportar OmniSeek.

## Verificação executada pelo Codex

- P40 `tests/test_research_mode.py`: 27/27;
- DZ23 STUDIO com PostgreSQL real: 174/174 e 100% de cobertura;
- typecheck, build, gate de domínios e gate P37: PASS;
- ZIP sintético: PASS, sem `.py`, wheel ou diretório `omniseek`;
- smoke do painel: perfil seguro e loopback subiram, mas `/healthz` retornou
  `sem_ia: true`; o processo foi encerrado e seus dados temporários removidos;
- o lançador foi corrigido para exigir JSON com pelo menos um modelo e agora
  bloqueia honestamente até uma IA local real estar ativa.

## Revisão pedida ao Claude

Revisar somente incompatibilidades concretas com o plano v2.0/P39/P40 e falhas
que possam invalidar a pesquisa. Não reabrir arquitetura, licença ou escopo já
congelados. Conferir especialmente neutralidade do roteiro, cálculo do gate,
isolamento entre participantes, ausência de segredo, validação real da IA local
e ausência de código do OmniSeek no ZIP.
