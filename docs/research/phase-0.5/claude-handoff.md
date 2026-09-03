# Handoff Claude × Codex — fase 0.5 reposicionada pela E4

## Estado

- base: `codex/p30-policy-foundation@dc1b0f82438db76555d9daa880f748f557d59128`;
- branch do kit: `codex/p05-usability-kit`;
- worktree: `C:\Users\zodyp\Documents\Codex\2026-09-01\com\work\p05-usability-kit`;
- OmniSeek P40 separado: `codex/p40-prototype-hardening@d9a8109528839a9f6c691cab9d71f3fce7e91e02`;
- fase humana: `SCHEDULED_AFTER_PHASE_9`;
- preflight atual: `BLOCKED_LOCAL_AI` — a porta 8000 responde com uma página de
  login, não com uma lista OpenAI-compatible de modelos;
- P32/P33/P31-B: liberados para construção pela E4;
- alvo final do teste: DZ23 STUDIO completo, não OmniSeek P40.

O estado técnico abaixo descreve o kit histórico `cdd2edb`. Seus lançadores
P40 não devem ser usados no gate final: depois da fase 9 serão adaptados ao
DZ23 STUDIO, preservando o protocolo e a prova negativa de rotas externas.

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

## Correções da revisão de 03/09/2026

- MEDIUM-1 fechado: o processo P40 agora nasce com ambiente vazio e allowlist;
  nenhuma chave de nuvem, login de CLI ou URL externa do host é herdada;
- prova negativa fechada: chave Anthropic falsa, `claude` falso e
  `OPENAI_BASE_URL` externa resultaram em zero rota externa/CLI;
- endpoint da IA local detectada é passado explicitamente em loopback;
- arquivos `.env.*`, chaves e certificados ignorados pelo Git agora bloqueiam
  o preflight;
- MEDIUM-2 fechado: a intenção de publicar é perguntada antes de qualquer
  pergunta sobre o que falta, evitando ensinar a resposta;
- o gate de preview exige explicação espontânea em palavras próprias e registra
  separadamente se o participante apenas citou o banner;
- consentimento de gravação ganhou formulário separado, anônimo e fora do
  diretório do protótipo; sem prazo de retenção preenchido, não há gravação.

Evidência executada: `27 passed`, `ROUTING_ISOLATION_PROOF=PASS`,
`IGNORED_SECRET_PROOF=PASS` e `PHASE05_LAUNCHER_PROOF=PASS`. A execução sem a
IA simulada continua bloqueada corretamente. Nenhuma sessão humana foi feita.

## Revisão pedida ao Claude

Revisar somente incompatibilidades concretas com o plano v2.0/P39/P40 e falhas
que possam invalidar a pesquisa. Não reabrir arquitetura, licença ou escopo já
congelados. Conferir especialmente as duas correções acima, cálculo do gate,
isolamento entre participantes, ausência de segredo, validação real da IA local
e ausência de código do OmniSeek no ZIP.
