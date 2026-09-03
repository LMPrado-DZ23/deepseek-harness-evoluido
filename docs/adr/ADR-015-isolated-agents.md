# ADR-015 — Agentes isolados, aprovações, orçamento e leases

Status: aceito na branch de revisão da Fase 3.

## Decisão

Codex e Claude Code só podem ser iniciados pela ação controlada do Studio. A
ferramenta genérica `tool-subagent` não é exposta a eles. Cada delegação:

1. exige aprovação T2; sobe para T3 se declarar deploy, segredo ou rede externa,
   e T3 exige passkey com identidade forte recente verificada pelo serviço de
   identidade, não apenas um campo de entrada;
2. cria um `git worktree` destacado no commit atual;
3. cria uma sessão coordenadora interna com `cwd` exatamente nesse worktree;
4. inicia um filho one-shot pelo provider oficial;
5. aplica prazo e limites de arquivos, bytes de diff e tokens quando mensuráveis;
6. devolve somente uma proposta; aplicar ao checkout da pessoa exige uma segunda
   aprovação T2.

A sessão coordenadora não aparece como sessão comum, não possui ferramentas do
usuário e é descartada ao final. A linhagem registrada liga sessão da pessoa,
coordenador e filho. O worktree é preservado quando há proposta ou falha.

## Garantias

`studio_agent_leases` impede duas delegações vivas com caminhos sobrepostos no
mesmo workspace. Ao aplicar, o diff e seu SHA-256 são recalculados. Alteração da
proposta, arquivo ocupado no checkout ou commit posterior à base que toque o
mesmo arquivo produzem falha fechada (`PROPOSAL_TAMPERED` ou `WRITE_CONFLICT`).
Uma edição concorrente do projeto principal durante a execução é registrada em
`main_changed_during_run`, com aviso neutro, mas não descarta a proposta; a
aplicação faz a decisão real de conflito. O fingerprint não percorre o conteúdo
de árvores não rastreadas. Nunca há merge ou commit automático.

Cada run grava a pessoa e o instante da aprovação inicial (`approved_by` e
`approved_at`).

O policy engine aceita a aprovação da delegação somente para descendentes da
sessão coordenadora cujo `cwd` continue igual ao worktree concedido. Uma regra
`deny` permanece `deny`; T3 continua exigindo identidade forte. Essa concessão
não altera a política global do Harness.

## Capacidades declaradas

Providers reais Codex/Claude não aceitam `toolFilter`, `persona` ou `maxDepth`
no `start`; o Studio declara `UNSUPPORTED_CAPABILITY` em vez de simular suporte.
Profundidade 1 é estrutural: a sessão coordenadora não entrega delegação ao
filho. `toolFilter` é exercitado somente no provider in-process de teste.

`spawn-in-process` não cria processo do sistema operacional; portanto SIGKILL
físico não existe nesse provider. A suíte injeta o resultado equivalente de
perda do filho e comprova `FAILED`; morte física fica para um provider
out-of-process real. Isso não é reportado como teste real de CLI.

## Cobertura

A lógica determinística (`service.ts`, schemas, policy e route-health) tem 100%
de statements, branches, funções e linhas. O glue de composição do Cordis e o
adaptador Git/SO são excluídos dessa métrica e cobertos por testes de integração
com repositório e worktree reais e pelo PoC 3A em WSL2/ext4.
