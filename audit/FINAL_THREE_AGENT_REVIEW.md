# Auditoria final de três revisores independentes — 09/09/2026 (rodada 2)

Objeto: `76c6f7d` e sucessores, sobre a base do commit `98d2650`. Os três
revisores trabalharam **isolados**: nenhum recebeu as conclusões dos outros.

- Revisor A — Architect / Engineering: `audit/` (rodada anterior desta sessão) e
  o achado que abriu esta rodada: **verde artificial no portão de i18n**.
- Revisor B — Security / DevSecOps: `audit/AUDITOR_B_SECURITY.md`.
- Revisor C — Product / QA / UX: `audit/AUDITOR_C_PRODUTO_UX.md`.

| Revisor | Veredito na entrega | Achados |
| --- | --- | --- |
| A | `NEEDS_FIX` | 1 CRITICAL · 1 MEDIUM · 1 LOW · 1 IMPROVEMENT |
| B | `NEEDS_FIX` | 0 CRITICAL · 2 HIGH · 8 MEDIUM · 5 LOW · 2 IMPROVEMENT · 2 FALSO-POSITIVO |
| C | `NEEDS_FIX` | 3 CRITICAL · 9 HIGH · 11 MEDIUM · 3 LOW · 6 FALSO-POSITIVO |

**O que esta rodada mostra.** Os três CRITICAL vieram de novo do revisor de
PRODUTO, e os dois HIGH de segurança são ambos sobre PROVAS que provavam a
coisa errada — não sobre o produto ser inseguro. O padrão que se repete nas
duas rodadas é o mesmo, e vale escrever com todas as letras: **o risco maior
deste projeto não é o código; é a evidência que parece cobrir e não cobre.**

## Corrigido nesta rodada, com prova

| Origem | Sev | Achado | Correção | Prova |
| --- | --- | --- | --- | --- |
| A | CRITICAL | `roleToolRestriction` nomeava ferramentas fora do preset do coordenador; `tools.restrict()` LANÇA com nome desconhecido, então toda delegação em processo quebraria. | Interseção com o roster real + portão que confere a constante contra o preset. | `0a13c6e`; erro real reproduzido antes da correção |
| A | MEDIUM | **Verde artificial**: o detector de i18n via português por ACENTO, e `route-health` escrevia as frases da pessoa sem acento — com comentário admitindo o motivo. O "1 literal herdado" era o que o detector conseguia ver. | `route-health` ganhou catálogo; o detector passou a ver palavra funcional sem acento e TERMINAÇÃO (-mente, -cao, -ncia, -dade, -mento, -ado…), só em literal com espaço. Os 51 literais que isso expôs foram migrados. | `98d2650`, `ee7c2a8`; `scripts/i18n-detector.spec.mjs` prova o par acento/sem-acento; `I18N_GATE=PASS plugin_literals_grandfathered=1` — agora um 1 medido por um detector que enxerga |
| B-1 | HIGH | `prove-container-hardening` importava `lib/` (saída de build, ignorada pelo Git) anunciando `src/`: o auditor reescreveu `hardenedHost` no FONTE para bridge, rootfs gravável e capacidade nenhuma, e a prova disse GO. | Passou a importar o FONTE, via tsx. | `ee7c2a8`; a mesma mutação agora reprova: `CONTAINER_HARDENING=FAIL - NetworkMode declarado bridge - a rede não foi bloqueada: ALCANCAVEL` |
| B-2 | HIGH | `gate:tracked-lib` VERMELHO em HEAD: `route-health/lib/index.js` (versionado) importava `./i18n.js`, que o `.gitignore` de `plugins/*/lib/` deixou de fora. Clone limpo quebraria com `ERR_MODULE_NOT_FOUND`. | Arquivos incluídos com `add -f`, como os demais `lib/` versionados. | `TRACKED_LIB=PASS files=179 findings=0` |
| B-3/M-1 | MEDIUM | O detector de i18n continuava contornável: `"Acesso negado: o token expirou. Entre novamente."` passava. | Detecção por terminação morfológica. | `scripts/i18n-detector.spec.mjs` |
| B-M2 | MEDIUM | `prove-builder-isolation` montava o contêiner com flags redigitadas à mão: provava a cópia. | Flags derivadas de `hardenedHost` importado do `src/`. | `6fca522` — **NÃO EXECUTADA** neste ambiente: exige a imagem OCI construída |
| B-M3 | MEDIUM | A chave do limitador de taxa saía do PRIMEIRO elemento de `X-Forwarded-For` — o que o cliente manda. Girar o cabeçalho dava balde novo a cada tentativa. | Passou a valer o ÚLTIMO hop; e os blocos do Studio no Caddy substituem o cabeçalho por `{remote_host}` em vez de acrescentar. | `6fca522`; teste exige a MESMA chave para prefixos forjados diferentes |
| B-M4 | MEDIUM | A CI não executava `gate:rls-coverage`, `gate:team-role-tools`, nem nenhuma prova `prove:*`. | Os dois portões entraram na etapa estática; `prove:container-hardening` ganhou etapa própria. | `.github/workflows/verify.yml` |
| B-M5 | MEDIUM | O portão de licenças só reprova em modo release, que a CI nunca chamava: o bloqueio de publicação era uma linha de log num passo verde. | Etapa própria, nomeada, rodando o modo release. Não reprova o commit porque a decisão é do Prado (C-05) — o que ela impede é a decisão ficar invisível. | `.github/workflows/verify.yml` |
| B-M7 | MEDIUM | A varredura de segredos isentava TODO `tests/`, `fixtures/` e `*.spec.*` — o lugar mais comum onde um segredo real é colado por engano. E senha toda em maiúsculas contava como marcador de posição. | Isenção NOMINAL (10 entradas com arquivo, regra e motivo) e conjunto fechado de marcadores. | `SECRET_SCAN=PASS achados=0 isencoes=11`; self-test invertido: segredo em teste REPROVA |
| B-M8 | MEDIUM | `gate:team-role-tools` adivinhava a tabela extensão→ferramenta — o erro que ele nasceu para impedir. | Nomes lidos do Harness fixado; extensão ilegível REPROVA. | `TEAM_ROLE_TOOLS=PASS extensoes_lidas=6/6`; um `multi_edit` de mentira em `tool-fs` foi apanhado pelo nome (upstream restaurado) |
| C-1 | CRITICAL | A tela dizia "Protótipo verificado" depois de o teste REPROVAR ou de a pessoa CANCELAR: a frase vinha do índice da ETAPA, e a etapa 4 é "Verificação". | A frase responde ao ESTADO, por tabela exaustiva; verificado é só `VERIFIED_PROTOTYPE`; falha e cancelamento ganharam frase própria. | `d76a7fb`; o teste passou a conferir os doze estados (antes, nove — faltando justamente os dois do defeito) |
| C-2 | CRITICAL | Quem escrevia a própria ideia recebia SEMPRE uma página de apresentação: `category` só mudava ao clicar numa das sete sugestões, e clicar apagava o texto. | Palpite determinístico por vocabulário (`suggestCategory`), VISÍVEL e corrigível na tela; sugestão não sobrescreve texto digitado. | `76c6f7d`; teste com as sete sugestões, oito pedidos escritos como uma pessoa escreve e o par difícil (painel que mostra × painel que edita) |
| C-3 | CRITICAL | Recarregar, ou clicar em qualquer item do menu, apagava o projeto da tela — e "Meus projetos" está desligado. | O projeto vive no endereço (`?projeto=`) e é restaurado ao abrir, deliberadamente só quando há plano ou execução (restaurar no meio das perguntas prenderia a pessoa numa etapa sem saída). | `d76a7fb`; `project-address.spec.ts` |
| C-H1 | HIGH | O acompanhamento desistia em 7 min e meio de uma execução que pode passar de 9, e chamava isso de falha de verificação. Uma leitura que falhasse encerrava tudo. | Limite de relógio folgado, frase honesta ("esta tela parou de acompanhar") e tolerância a falhas seguidas. | `d76a7fb` |
| C-H2 | HIGH | Estourar o teto de gasto virava "uma verificação encontrou um problema": a pessoa iria procurar defeito no aplicativo dela. | `BUDGET_EXCEEDED` entrou no tipo e ganhou frase própria com o que fazer. Estado final e frase saem do MESMO tipo. | `1c168b2`; teste cobre os sete estados terminais |
| C-H5 | HIGH | O erro mostrava `HTTP 502` ou a palavra `Atenção` sozinha. | Código de máquina vira frase com o que fazer, e o código viaja no fim dela. Frase que o servidor mandou continua valendo. | `1c168b2`; `apiFailure.spec.ts` |
| C-H6 | HIGH | O ícone de Ajuda estava desligado num produto para leigos com vocabulário próprio. | `/studio/ajuda`: as cinco etapas, glossário de 16 termos e o que o Studio nunca faz. | `1c168b2`; e2e com axe |
| C-H7 | HIGH | Nenhum botão do fluxo principal avisava que estava trabalhando. | `PendingButton`: desabilita, gerúndio e `aria-busy`. | `1c168b2`; e2e ATRASA a resposta e prova que o segundo clique não vira segundo projeto — enfraquecer o botão reprova o teste |
| C-H8 | HIGH | O e2e desligava metade da jornada por diagnóstico ERRADO: culpava `pipeline.ts`, quando quem não devolvia atestação era o SERVIDOR DE TESTE. Ficaram sem teste a prévia, a notificação, o protótipo verificado e a única varredura axe de página inteira. | Dublê devolve os fatos do construtor; atestação, resumos e veredito continuam do produto. | `76c6f7d`; e2e 38 passa nos três tamanhos |

Fora da lista dos revisores, apanhado ao corrigir: `build-i18n-baseline.mjs`
devolvia `[]` tanto para "não há literal" quanto para "este clone não tem a
revisão" — e rodá-lo aqui APAGOU em silêncio o baseline inteiro do
`prompt-to-app`. Agora ele recusa rodar sem as revisões de base. E o
`typecheck` do repositório, que estava com 22 erros anteriores a esta sessão,
ficou limpo.

## Em aberto

| Origem | Sev | Achado | Situação |
| --- | --- | --- | --- |
| B-M6 | MEDIUM | O token CSRF é função determinística e imutável do token de sessão; não rotaciona em step-up. | ABERTO. Correção exige semente por sessão (campo novo no domínio) e reemissão em elevação. |
| C-H3 | HIGH | "Critérios conferidos" mostra identificadores de máquina. | ABERTO |
| C-H4 | HIGH | Jargão de circuito, teto e nome de provedor na PRIMEIRA tela. | ABERTO |
| C-H9 | HIGH | "O que foi recusado" mostra códigos crus fora dos Detalhes técnicos. | ABERTO |
| C-M1…M11 | MEDIUM | Cobertura de axe restrita a 3 telas, vocabulário técnico, "Progresso" que leva ao painel de equipes, transbordo entre 821 e 950px, modo escuro só no assistente, células do ledger que descrevem cobertura maior do que a executada, o Hub pedindo nome de segredo a leigo. | ABERTO |
| A | LOW/IMPROVEMENT | `classifyBuilderUnixClientFailure` sem uso; `main`→`lib/` contra `types`→`src/` divergentes entre plugins. | ABERTO |
| B | LOW | Cinco achados menores do relatório de segurança. | ABERTO |

## Bloqueios externos (não são achados)

`C-05` (decisão jurídica do Prado sobre os pacotes não redistribuíveis),
`P-07` (chave real de LLM), `S-04` (Caddy precisa de egress de módulos Go),
`D-09` (Android físico), `D-10` (registro de pacotes alcançável do contêiner),
`H-11` (conversa real longa) e `U-04` (uma pessoa leiga de verdade).

---

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
