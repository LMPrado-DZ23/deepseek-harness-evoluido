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

## Condição para iniciar P01

1. Iniciar Ollama, LM Studio ou vLLM em `localhost` com pelo menos um modelo.
2. Reexecutar o lançador com `-PreflightOnly` até retornar `status: PASS`.
3. Fazer um smoke de `/healthz` e confirmar `sem_ia: false`.
4. Só então iniciar a sessão `P01`.
