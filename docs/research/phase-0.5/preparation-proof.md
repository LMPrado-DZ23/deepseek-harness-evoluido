# Prova de preparação da fase 0.5

**Data:** 02/09/2026  
**Branch:** `codex/p05-usability-kit`  
**Base:** `dc1b0f82438db76555d9daa880f748f557d59128`  
**Pesquisa humana:** `NOT_EXECUTED`

## Resultado

O material de pesquisa e os lançadores estão preparados. A execução com
participantes permanece bloqueada porque nenhuma IA local válida está ativa no
notebook neste momento.

Esse bloqueio é intencional: o preflight recusa uma porta que apenas responde
HTTP. Ele exige JSON de Ollama/OpenAI-compatible com pelo menos um modelo.

## Evidência executada

| Verificação | Resultado |
|---|---|
| Parser PowerShell dos dois scripts | PASS |
| `bash -n` do lançador WSL2 | PASS |
| P40 `tests/test_research_mode.py` | 27 passed |
| Prova controlada do lançador | PASS |
| Chave falsa + CLI `claude` falsa + URL externa | nenhuma rota externa ou CLI; PASS |
| Arquivo `.env.*` ignorado pelo Git | recusado; PASS |
| Commit P40 | `d9a8109528839a9f6c691cab9d71f3fce7e91e02` |
| Árvore P40 | limpa |
| Python P40 | 3.12.3 em `/home/leandro/omsfinal/.v/bin/python` |
| Docker no WSL2 | disponível |
| Gate P37 sobre o Studio | PASS, 0 achados |
| Typecheck do Studio | PASS |
| Testes sem PostgreSQL | 156 passed, 18 skipped |
| Testes com PostgreSQL 16 | 174 passed |
| Cobertura dos pacotes Studio | 100% statements/branches/functions/lines |
| Build dos pacotes Studio | PASS |
| Gate de domínio/tenant scope | PASS |
| Geração e inspeção do ZIP | PASS |

## Smoke e correção do preflight

A primeira versão do preflight tratou `http://127.0.0.1:8000/v1/models` como IA
local apenas porque recebeu HTTP sem erro. O conteúdo real era HTML com redirecionamento
para `/login`. O perfil P40 subiu em `127.0.0.1:18080`, mas `/healthz` respondeu:

```json
{"status":"ok","sem_ia":true,"research":{"enabled":true}}
```

O processo foi encerrado, a porta fechou e o diretório temporário `P05-R9` foi
removido depois de validar seu caminho absoluto.

O lançador agora analisa o JSON e exige ao menos um item com `name`, `id` ou
`model`. A repetição terminou como esperado:

```text
PREFLIGHT_FALSE_POSITIVE_FIX=PASS
EXPECTED_BLOCKER=NO_LOCAL_AI_MODEL
```

Nenhum fluxo de participante, geração de aplicação, chamada externa, deploy,
push ou publicação foi executado.

## Correções após a revisão independente

O lançador não usa mais uma lista de segredos conhecidos para limpar o ambiente.
Ele inicia testes e servidor com `env -i` e uma lista explícita composta apenas
por `PATH`, `HOME`, idioma, controles seguros do P40, diretório de dados e o
endpoint local detectado. A IA local é passada por uma única variável adequada
ao provedor (`OLLAMA_HOST`, `LMSTUDIO_HOST` ou `VLLM_BASE_URL`), sempre em
`127.0.0.1`.

A prova `scripts/prove-phase05-launcher.sh` criou, temporariamente, um servidor
Ollama compatível em loopback e executou o preflight com:

- `ANTHROPIC_API_KEY=fake`;
- um binário `claude` executável e falso no `PATH` da prova;
- `OPENAI_BASE_URL=http://203.0.113.1`.

O P40 viu o binário falso, mas `cli_routes()` permaneceu vazio;
`_api_entries()` permaneceu vazio; e todos os endereços externos injetados nas
rotas locais foram reduzidos a loopback. Resultado:

```text
27 passed
ROUTING_ISOLATION_PROOF=PASS
IGNORED_SECRET_PROOF=PASS
PHASE05_LAUNCHER_PROOF=PASS
```

Em seguida, sem a IA local simulada, o preflight voltou a recusar a execução
com `Nenhuma IA local respondeu em localhost`. Portanto, a fase humana continua
honestamente `NOT_EXECUTED` e `BLOCKED_LOCAL_AI_MODEL`.

O protocolo também foi corrigido para perguntar se a pessoa publicaria o
resultado antes de explicar o que falta. O gate de preview só conta quando a
pessoa explica com palavras próprias que o preview não está publicado nem
disponível para outras pessoas; o formulário registra separadamente se ela
citou o aviso permanente.

## Condição para iniciar P01

1. Iniciar Ollama, LM Studio ou vLLM em `localhost` com pelo menos um modelo.
2. Reexecutar o lançador com `-PreflightOnly` até retornar `status: PASS`.
3. Fazer um smoke de `/healthz` e confirmar `sem_ia: false`.
4. Só então iniciar a sessão `P01`.
