# ADR-014 — Rotas de modelos e saúde por rota

Status: aceito na branch de revisão da Fase 3.

## Decisão

O DZ23 STUDIO compõe três rotas físicas sobre o Harness fixado em `6c705be`:

- `deepseek-official`, fornecida pelo plugin oficial `llm-deepseek`;
- `omniroute`, endpoint OpenAI-compatible externo e opcional;
- `ollama`, endpoint OpenAI-compatible local.

Cada requisição usa uma única rota. 9Router não integra o perfil. OmniRoute e
Ollama têm `retryPolicy.maxRetries: 0`; o gateway, quando usado, é a autoridade
única de repetição e fallback. Chaves são nomes de variáveis, nunca valores no
profile.

`@dz23-studio/route-health` observa o stream, grava saúde, latência, uso e custo
estimado por `org_id`/`tenant_id` em `studio_route_health` e oferece
`chooseRoute`. Para T0, Ollama saudável é preferido. Escolha explícita da pessoa
nunca é substituída.

Só existe fallback automático de `omniroute` para `deepseek-official` quando a
falha ocorre antes de qualquer conteúdo visível ou tool call. Depois disso, o
Studio não repete nem troca de rota; devolve erro comum e auditável. Toda troca
gera um evento com origem, destino e motivo.

## Limites

O estado inicial indica presença no profile, não disponibilidade de rede. O
preflight separado faz somente `GET /models` em loopback e diferencia
`NOT_CONFIGURED` de `DOWN`. Custos são estimados apenas quando há preço
configurado e uso reportado.

## Consequências

Não há cascata silenciosa do perfil privado local para serviço externo. Não há
retry no meio do stream. O OmniRoute continua opcional conforme E1/E2 e nenhum
subsistema MITM, TPROXY ou instalador de CA entra no Studio.

