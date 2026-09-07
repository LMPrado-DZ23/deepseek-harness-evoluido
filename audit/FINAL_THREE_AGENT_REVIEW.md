# Auditoria final de três revisores independentes — 07/09/2026

Objeto: candidata cumulativa `dba2787`, base `codex/m89-immutable-staging@f1677b4`.
Os três revisores trabalharam **isolados**: nenhum recebeu as conclusões dos
outros, e cada um entregou um arquivo próprio, preservado em `docs/audit/`.

| Revisor | Papel | Veredito | Achados |
| --- | --- | --- | --- |
| A | Architect / Engineering | `NEEDS_FIX` | 0 CRITICAL · 4 HIGH · 7 MEDIUM · 3 LOW · 3 IMPROVEMENT |
| B | Security / DevSecOps | `GO_LIMITED` | 0 CRITICAL · 0 HIGH · 2 MEDIUM · 5 LOW · 1 INFO |
| C | Product / QA / UX | `NEEDS_FIX` | 3 CRITICAL · 7 HIGH · 10 MEDIUM · 4 LOW · 2 IMPROVEMENT |

**Vale registrar o que isso significa.** A auditoria de segurança ofensiva não
achou nenhum ALTA: o isolamento entre pessoas, sessões, organizações e
inquilinos resistiu a ataque real e provado por execução. Os três CRITICAL
vieram do revisor de **produto** — e são todos sobre a pessoa que vai usar isto.
É exatamente a ordem de prioridade errada que este projeto se comprometeu a não
aceitar: um sistema pode estar seguro e, ainda assim, ser inutilizável para
quem ele deveria servir.

## O que foi corrigido nesta rodada

| Origem | Sev | Achado | O que foi feito | Prova |
| --- | --- | --- | --- | --- |
| C-1 | CRITICAL | No modo escuro, a conversa ficava **ilegível**: os blocos `prefers-color-scheme:dark` escureciam o fundo dos balões e deixavam a cor do texto herdada do tema claro. Contraste medido: **1,05:1**, onde o mínimo é 4,5:1. | Toda superfície escura passou a declarar a própria cor. Pares recalculados: 14,95:1 · 13,98:1 · 9,57:1 · 15,18:1 · 16,24:1 · 10,10:1. | `contrast.spec.ts` **calcula** o contraste a partir da folha e reprova qualquer regra escura que mude o fundo sem declarar o texto. Mutação: remover a cor do balão reprova o teste. |
| C-1b | CRITICAL | O "teste 12 de acessibilidade" do M91 só procurava a string `prefers-reduced-motion` na folha — e **aprovava** a folha ilegível acima. | Substituído por verificação estrutural e por contraste calculado. | idem |
| C-3 | CRITICAL | O aviso de erro **sumia sozinho em 1,5 s**: cada leitura bem-sucedida chamava `setError(null)`, e a leitura roda a cada 1.500 ms. Um envio recusado desaparecia antes de a pessoa terminar de ler — ela achava que tinha enviado. | Dois avisos separados: o de **leitura** some quando a leitura volta (descreve o agora); o de **ação** (enviar, parar, organizar) **não some sozinho** e ganhou o botão "Entendi". | `Conversation.tsx` |
| C-4 | HIGH | A fila casava mensagem com histórico **por texto em conjunto**: duas mensagens iguais na fila sumiam as duas quando uma chegava — quebrando exatamente a promessa "sua mensagem está guardada". | Passou a casar **por contagem**. | `settleQueue` em `conversationState.ts` |
| C-2 | HIGH | Frases mandavam a pessoa fazer o impossível: "feche ou termine uma delas" (fechar conversa não existe), "é preciso resolver aquela execução" (não há botão). Além disso "este dispositivo" quando o limite é por sessão de identidade. | Frases reescritas para dizer a verdade e oferecer o que existe de fato, inclusive admitindo que **esta versão ainda não tem botão** para resolver a execução desconhecida. | catálogos de `identity` e `agents` |
| C/A | HIGH | Uma falha passageira do Harness virava `NOT_FOUND` — "conversa não encontrada" — e ainda **tirava da pessoa o botão de tentar de novo**, porque 404 é classificado como não recuperável. | A posse já é verificada antes; falha de leitura virou `SESSION_UNAVAILABLE` com frase própria. 404 continua para conversa que realmente não é da pessoa. | teste com as duas pernas |
| C | MEDIUM | Erro devolvia à pessoa o texto `Envie a mensagem em JSON, no formato {"text": "sua mensagem"}`. | Reescrito em linguagem de gente. | catálogo de `studio-web` |
| A-H1 | HIGH | A exclusão mútua de `confirm`/`consume` dependia **inteiramente** de `put(record, expectedState)` — escrita condicional que o seam real de domínio **não oferece** (`KvTable` expõe `put(chave, valor)`). Um adaptador durável emitiria **dois recibos** para a mesma confirmação. | `KeyedMutex` no serviço. A condição continua como defesa em profundidade. | Teste novo usa um repositório que **ignora** `expectedState` — como o seam real. Mutação: remover o mutex reprova. |
| A-H2 | HIGH | `plugins/*/lib` rastreado e desatualizado; o `lib` commitado **ainda continha a rota `/bind-agent`** que esta integração removeu por segurança. Produção resolve `lib`. | `pnpm build` e os artefatos reconstruídos entraram no commit. Nada foi apagado nem desrastreado. | `grep bind-agent plugins/identity/lib/http.js` → 0 |
| A-H3 | HIGH | `prove:agent-restart` quebrado pelo merge **e** com quatro asserções tautológicas (`reconciledAt: <o próprio valor lido>`). | Contadores comparados de verdade; `reconciledAt` validado como carimbo ISO real. | prova executada de ponta a ponta: `EXIT=0`, três fases, processos separados |
| A-M6 | MEDIUM | `applyTargetEnvironment` só **definia** variáveis presentes na URI; `PGHOST`/`PGUSER` herdados do ambiente sobreviveriam **contradizendo o alvo** — a ferramenta iria para outro servidor achando que foi para este. | Cada campo agora é definido **ou apagado**. | Teste com ambiente herdado hostil. Mutação: voltar a só definir reprova. |
| A-M4 | MEDIUM | Erro numa rota da conversa respondia `text/plain`; o cliente perdia a mensagem e mostrava um erro genérico no lugar de "entre de novo". | Rotas da conversa respondem JSON também no caminho de erro. | teste próprio |
| A-M2 | MEDIUM | `#hasPersistedWork()` reconstruía um `Set` sobre todas as execuções **dentro** do predicado. | Conjunto construído uma vez. | — |

## O que continua em aberto, e por quê

| Origem | Sev | Achado | Estado |
| --- | --- | --- | --- |
| B-1, C-2a, A-H4 | HIGH | **Três estados sem saída pela interface**: `approval.requested` não tem onde confirmar; `resolveUnknownRun` não tem rota nem tela; o plugin `action-approval` **não está montado em perfil nenhum**. | `NOT_IMPLEMENTED`, declarado. O contrato do M90-A dizia explicitamente "não montar o plugin em perfil nesta fatia". A autoridade existe e é provada; **o consumidor é outra fatia**. Enquanto isso as frases foram corrigidas para não mandar a pessoa fazer o impossível. |
| B-1 | MEDIUM | O portão T2/T3 que de fato roda continua sendo o `approval: { approved: true, tier }` fabricado em `plugins/assistant-bridge/src/service.ts` — **pré-existente a `f1677b4`, não é regressão desta candidata**. | Registrado. É exatamente o que a autoridade do M90-A existe para substituir, e é a próxima fatia natural. |
| A-M1 | MEDIUM | `shutdown(deadlineMs)` existe, é testado e **nunca é chamado** pelo runtime. | Registrado. Ligá-lo exige um seam de encerramento do perfil que esta fatia não tocou. |
| A-M5 | MEDIUM | `ownsHarnessSession` materializa a lista inteira de sessões a cada chamada. | Registrado; custo aceitável no tamanho atual, revisitar com muitas sessões. |
| A-M7 | MEDIUM | `SESSION_CONFLICT` no launcher quando o `cwd` diverge deixa a pessoa sem caminho. | Registrado. |
| C | MEDIUM | A `CAPABILITY_MATRIX` não citava, na coluna "Falta", os becos sem saída que as próprias provas registram. | **Corrigido** neste commit. |

## Gates depois das correções

Container Linux, PostgreSQL 16.13 real, Harness no pin `6c705be1`:

- `tsc --noEmit` **PASS** · `pnpm build` **PASS**
- suíte raiz com PostgreSQL: **2199 aprovados**, 3 reprovados
- `apps/studio-web`: 20 arquivos, **106 testes PASS**
- coverage: statements 95,75% · branches 92,95% · functions 95,65% ·
  lines 97,90% — **zero violação de limiar**
- `I18N_GATE=PASS` · `DOMAIN_ROUTE_GATE=PASS domains=26` · domain-scopes **PASS**
  · `PORTABILITY=PASS findings=0`
- `prove:agent-restart` **PASS** de ponta a ponta, três fases, processos separados

As 3 reprovações continuam sendo as guardas POSIX do `builder-supervisor`
derrotadas pelo **uid 0** do container; como usuário sem privilégio passam
**103/103**.

## Veredito do integrador

`CANDIDATE_COMPLETED` **não** é `COMPLETED`, e esta candidata **não** é
`COMPLETED`.

Os três CRITICAL foram corrigidos e provados. Os HIGH de arquitetura foram
corrigidos e provados. O que resta em aberto é, em sua maioria, **superfície que
falta** — não defeito escondido: o plugin de confirmação não está montado, e há
estados cuja saída ainda não tem botão. Isso está escrito aqui, na matriz de
capacidades e nas frases que a pessoa lê.

E continua valendo o que nenhum teste resolve: Docker, Windows nativo, celular
físico, domínio e SMTP reais, e a fase 0.5 com cinco pessoas leigas. Sem isso,
não existe "pronto".
