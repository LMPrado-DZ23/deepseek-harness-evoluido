# Prova M75-B — encerramento comprovado antes de liberar a reserva

Base: `codex/m75-agent-restart-reconciliation-v2@3b777ed`.
Autor: Claude (Opus 5) — 07/09/2026.

## O achado ALTA, dito sem rodeio

A reconciliação do M75 pergunta `jobs.hasLiveJobs()` — e esse método só enxerga
o registro de jobs **dentro do processo** do Harness. Depois de um reinício esse
registro está vazio *por construção*, não por evidência.

Mas uma execução com provedor `codex` ou `claude-code` é um **processo do
sistema operacional com vida própria**. Ele sobrevive ao reinício do Studio e
continua escrevendo na cópia isolada.

Com o código anterior, a sequência era: "não há job vivo" → marca a execução
como `FAILED` → **libera a reserva de arquivos**. A reserva é justamente o que
impede dois agentes escreverem nos mesmos caminhos. Resultado possível: dois
processos escrevendo no mesmo lugar, com o registro afirmando que o primeiro
falhou.

## O segundo achado, que ninguém tinha reportado

A reserva durável **não protegia nada**, nem antes nem depois. `start()` só
comparava os caminhos pedidos contra `#activePaths`, um mapa **em memória**.
Depois de um reinício esse mapa está vazio. Ou seja: bastava reiniciar o Studio
para que qualquer reserva preservada fosse ignorada.

Preservar a reserva sem esta segunda correção teria sido teatro.

## O que foi feito

1. **Estado `UNKNOWN`** no domínio de execuções (`studio_agent_runs` v2 → v3).
   Não é falha nem sucesso: é **ausência de prova**, e por isso é bloqueante.
   `spawn-in-process` morre junto com o Studio, então o reinício **é** prova —
   essas continuam virando `FAILED` com a reserva liberada. `codex` e
   `claude-code` viram `UNKNOWN` e a reserva **fica ativa**.
2. **`start()` passa a respeitar a reserva durável**, recortada por espaço de
   trabalho e repositório.
3. **O conflito em memória também passou a ser recortado** por espaço de
   trabalho e repositório. Sem isso, duas organizações que por acaso editassem
   `src` bloqueariam uma à outra — e cada uma saberia que a outra está
   trabalhando ali. Era indisponibilidade cruzada e vazamento de sinal entre
   inquilinos ao mesmo tempo.
4. **`resolveUnknownRun(runId, motivo)`** — a única saída do estado desconhecido
   é uma pessoa confirmar, com motivo, e o motivo fica no registro. Nenhuma
   prova técnica sustentou aquela conclusão; então o registro diz quem decidiu.
5. **`shutdown(deadlineMs)`** com prazo autoritativo (`SHUTDOWN_DEADLINE_MS`,
   15 s). O que não terminar dentro do prazo **não é declarado morto**: é
   reportado como pendente e fica para a reconciliação do próximo início.
6. **`UNKNOWN` no domínio de tarefas de equipe** (`studio_agent_teams` v1 → v2)
   e incluído nos estados que levam a equipe a `NEEDS_ATTENTION`. Uma equipe
   nunca pode ser dada como concluída com uma tarefa sem encerramento provado.

## O que NÃO foi feito, e por quê

O Studio **não consegue** provar a morte de uma CLI externa. O seam público do
Harness no pin `6c705be1` entrega `SubagentRun` com `id`, `localAgent`,
`result` e `dispose()` — **nenhuma identidade de processo do sistema
operacional**. Sem pid + horário de início não há como distinguir "morreu" de
"pid reaproveitado por outro programa".

Alterar o submódulo é proibido, e inventar uma heurística seria exatamente o
erro que esta fatia corrige. Portanto: `BLOCKED_EXTERNAL` para a liberação
automática, e o pedido de seam upstream fica registrado aqui.

`NOT_IMPLEMENTED`: rota HTTP ou tela para `resolveUnknownRun`. Hoje a saída do
estado desconhecido existe no serviço e é testada, mas ainda não tem superfície.
Enquanto não tiver, aqueles arquivos ficam reservados. Digo isso em vez de
fingir que o fluxo está completo.

## Provas de mutação (guarda que não pode falhar não é guarda)

| Mutação | Teste que reprova |
|---|---|
| `survivesRestart` sempre `false` (tratar externo como provável) | "não declara morto o que não pode provar" |
| remover a checagem de reserva durável em `start()` | "a reserva preservada realmente bloqueia" |
| contar como encerrado o que não terminou no prazo | "o encerramento ativo tem prazo" |
| remover o recorte por espaço/repositório do conflito em memória | "a reserva preservada realmente bloqueia" |

## Gates executados

Clone limpo, container Linux, Harness no pin, submódulo sem diff:

- `tsc --noEmit` **PASS**; `pnpm build` **PASS**
- `plugins/agents` + `plugins/agent-team`: 7 arquivos, **90 testes PASS**
- suíte raiz: **2036 aprovados**, 60 pulados, 3 reprovados
- coverage: statements 96,06% · branches 93,43% · functions 96,61% ·
  lines 98,09% — **zero violação de limiar**, incluindo o 100% obrigatório de
  `plugins/agents/src/{model,service}.ts`
- `I18N_GATE=PASS`; domain-scopes **PASS**; `PORTABILITY=PASS findings=0`

As 3 reprovações são as guardas de permissão POSIX do `builder-supervisor` que
o uid 0 do container derrota; como usuário sem privilégio passam 103/103. Não
tocam esta fatia.
