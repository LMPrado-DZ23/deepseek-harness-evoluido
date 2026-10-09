# Auditoria C — Produto / QA / UX
## DZ23 STUDIO — candidata cumulativa `dba2787` (base `f1677b4`)

Auditor C. Somente leitura. Sem navegador: toda afirmação abaixo vem do código,
dos catálogos, dos testes que rodei (`apps/studio-web`: 6 arquivos, 34 testes,
todos passando) e da folha de estilo real. Onde não pude verificar, está escrito
`NÃO VERIFICADO`.

---

# VEREDITO: `NEEDS_FIX`

A fatia é séria e, em vários pontos, exemplarmente honesta — a faixa de
compactação recusa inventar porcentagem, o `RECONCILING` recusa dizer
"concluído", e a prova M75-B escreve o próprio beco sem saída em vez de
escondê-lo. Isso é raro e merece ser dito.

Mas a régua do projeto é "nunca chamar de pronto o que não foi provado" e
"segurança e verdade não podem se esconder atrás de jargão". Por essa régua a
tela ainda não pode ir para uma pessoa leiga:

1. **Em aparelho no modo escuro, o texto das mensagens fica ilegível** (contraste
   1,05:1 — medido). A pessoa abre o chat e não lê nada.
2. **Existem três estados dos quais não há saída pela interface**: pedido de
   confirmação de ação, execução em estado desconhecido, e cota de 8 conversas.
   Nos três a tela pede à pessoa que faça algo que a interface não oferece.
3. **Um erro de envio desaparece sozinho em 1,5 segundo.** A pessoa pode achar
   que mandou a mensagem quando não mandou.

Nenhum desses é hipotético; todos são verificáveis no código sem navegador.

**Contagem:** CRITICAL 3 · HIGH 7 · MEDIUM 10 · LOW 4 · IMPROVEMENT 2.

---

# Tabela de achados

| # | Sev | Arquivo:linha / chave | Problema | Por que dói para um leigo | Correção sugerida |
|---|-----|----------------------|----------|---------------------------|-------------------|
| C1 | CRITICAL | `apps/studio-web/src/styles.css:38-45` (e `:56-61`) | O bloco `@media (prefers-color-scheme:dark)` escurece o fundo dos balões (`.conversation-item{background:#161d2f}`, `.message-user{#12233f}`, `.compaction-band{#101c31}`) mas **não** redefine a cor do texto. `.conversation-item p`, os `<strong>` da faixa e do pedido de confirmação continuam herdando `:root{color:#0b1739}`. Medido: **1,05:1**, **1,12:1** e **1,03:1**. O mínimo WCAG AA é 4,5:1. São os dois únicos blocos de modo escuro da folha inteira — o resto do app é claro, então o fundo da página continua branco e só a conversa escurece. | A pessoa com o celular no modo escuro (padrão em muitos aparelhos hoje) abre o chat e **não enxerga as próprias mensagens nem as do assistente**. Ela não vai concluir "falta contraste"; vai concluir que o produto está quebrado. | Ou definir no bloco escuro `:root{color-scheme:dark;background:#0b1220;color:#eef2f9}` junto com `.conversation-item p, .conversation-item strong, .compaction-band strong{color:#eef2f9}`; **ou** remover os dois blocos escuros e assumir um único tema claro. O que não pode existir é meio tema. |
| C2 | CRITICAL | `Conversation.tsx:241-243` + `plugins/studio-web/src/assistant-http.ts:22-60` | O evento `approval.requested` é renderizado como **"Aguardando sua confirmação"** e nada mais. Não há botão Confirmar/Recusar, e o roteador da conversa expõe exatamente quatro ações: `open`, `events`, `messages`, `cancel`. Não existe rota de aprovação. O plugin `action-approval` existe e tem rota (`/studio/approvals/:id/confirm`), mas **não está montado em lugar nenhum** (só aparece nos gates de domínio). | A tela diz literalmente "Aguardando sua confirmação" para uma pessoa que **não tem onde confirmar**. Ela vai esperar. A conversa fica parada. O único botão disponível (Parar) não é apresentado como resposta ao pedido, e nem sempre está visível (ver H2). É o beco sem saída mais cruel da tela: o produto pede uma ação e esconde o botão. | Enquanto não houver resolução na tela, **não escrever "Aguardando sua confirmação"**. Trocar por: *"O DZ23 pediu permissão para {ação}. Esta tela ainda não sabe responder a esse pedido — responda pela janela do assistente, ou toque em Parar para encerrar esta tarefa."* E registrar a limitação na matriz. Correção definitiva: montar `action-approval` e desenhar os dois botões. |
| C3 | CRITICAL | `plugins/agents/src/service.ts:258,383` · `plugins/agents/i18n/pt-BR.json` → `recovery.blockedByUnknown` | A mensagem diz: *"…é preciso resolver aquela execução antes de começar outra aqui."* `resolveUnknownRun(runId, reason)` é a única saída — e ela **não tem rota HTTP, não tem tela, e não está entre as 13 ferramentas do preset** (`plugins/assistant-bridge/src/catalog.ts:5-17`). Confirmado por busca: só os testes a chamam. | A pessoa é instruída a "resolver a execução anterior" e não existe nenhum lugar no produto onde resolver. Os arquivos dela ficam reservados **para sempre**, e o assistente repete a mesma recusa em toda tentativa. Um leigo não vai abrir um terminal. | Curto prazo: mudar a frase para não pedir uma ação impossível — *"Uma tarefa anterior ficou sem confirmação de encerramento e por isso estes arquivos continuam reservados. Nada foi perdido. Ainda não existe um botão para liberar; peça ajuda a quem instalou o DZ23."* Prazo real: expor `resolveUnknownRun` como ferramenta T2 ou tela. (A prova M75-B declara isso como `NOT_IMPLEMENTED` — honesto; a matriz não repete, ver M9.) |
| H1 | HIGH | `Conversation.tsx:68` (`setError(null)` dentro do `read`) + `:27` (`CONVERSATION_POLL_MS = 1500`) | Toda leitura bem-sucedida do histórico limpa o erro. Como a leitura roda a cada 1,5 s, **qualquer erro de envio ou de "Parar" some da tela em no máximo 1,5 segundo**. | A pessoa clica em Enviar, o servidor recusa, aparece um aviso vermelho — e ele desaparece antes de ela terminar de ler. Ela fica achando que enviou. É exatamente o oposto de "a pessoa sabe se a mensagem dela foi guardada". | Separar os dois erros: um estado `loadError` (que a leitura pode limpar) e um `actionError` (que só a próxima ação da pessoa limpa). Erro de ação nunca deve sumir sozinho. |
| H2 | HIGH | `Conversation.tsx:180` + `conversationState.ts:96-99` + chave `emptyBody` | `conversationStatus` devolve `'queued'` sempre que há mensagem na fila, e o botão **Parar** só é renderizado quando o status é exatamente `'working'`. Ou seja: entre o envio e o momento em que o journal devolve a mensagem, **não existe botão Parar**. E o estado vazio promete: *"Você pode parar a qualquer momento."* | A promessa é literalmente falsa justamente na janela em que a pessoa mais quer parar — logo depois de clicar em Enviar e perceber que escreveu errado. | Mostrar Parar quando `status !== 'idle'` (fila **ou** trabalho), já que a rota `cancel` não depende de a mensagem ter chegado ao journal. Se não puder, corrigir a frase: *"Enquanto o DZ23 estiver respondendo, aparece um botão Parar."* |
| H3 | HIGH | `conversationState.ts:48` e `:56` | A fila é limpa comparando **texto**: `delivered = new Set(events.filter(isUserMessage).map(e => e.text))` e depois `queued.filter(m => !delivered.has(m.text))`. Reproduzi: duas mensagens na fila com o mesmo texto e **uma** chegando no journal → a fila fica vazia; as duas somem. O identificador estável (`request_id`) existe e é ignorado nessa comparação. | A pessoa manda "ok" duas vezes (o que acontece o tempo todo em chat). A segunda desaparece da tela como se tivesse sido entregue. Ela não tem como saber que se perdeu uma. Isso quebra a única garantia que a tela dá: "sua mensagem está guardada". | Casar fila e journal pelo `request_id` — o `send` já devolve um, e o projetor pode carregá-lo no evento `message.user`. Enquanto o contrato upstream não carregar, remover só **uma** entrada por texto entregue, nunca todas. |
| H4 | HIGH | `plugins/studio-web/src/assistant-conversation.ts:88-92` + `conversationApi.ts:136-139` | O `snapshot` embrulha **qualquer** exceção do Harness (queda, timeout de 30 s, rede) em `NOT_FOUND` → HTTP 404 → mensagem *"Conversa não encontrada."*. E 404 é classificado como **não recuperável**, então a tela **não mostra o botão "Tentar de novo"**. | Uma falha passageira é anunciada à pessoa como se a conversa dela tivesse sido apagada — o pior significado possível — e ainda sem nenhum botão para tentar de novo. É jargão de HTTP virando pânico. | Separar a causa: falha de leitura vira `SESSION_UNAVAILABLE` (503, recuperável) com *"Não consegui ler sua conversa agora. Ela continua guardada. Vou tentar de novo em instantes."*; `NOT_FOUND` fica só para conversa que realmente não pertence à pessoa. |
| H5 | HIGH | `plugins/studio-web/i18n/pt-BR.json` → `assistant.invalidMessage` | Texto atual: **`Envie a mensagem em JSON, no formato {"text": "sua mensagem"}.`** Ele é lançado por `assertPromptText` (`assistant-conversation.ts:324-327`) quando a mensagem passa de 32 KiB ou contém `\0` — ou seja, **por texto que a própria pessoa digitou** — e é exibido cru no aviso da tela (`conversationApi.ts:137` usa `body.error`). | A pessoa cola um texto longo, clica em Enviar, e recebe uma instrução de programador sobre JSON. Ela não sabe o que é JSON, não sabe qual é o problema real (tamanho) e não sabe o que fazer. | Separar as causas. Para tamanho: *"Sua mensagem é longa demais para enviar de uma vez. Divida em duas ou três partes — o que você escreveu não foi apagado."* A mensagem sobre JSON é sobre o **corpo da requisição** e nunca deve chegar a uma pessoa; ela pertence ao log. |
| H6 | HIGH | `apps/studio-web/src/i18n/assistant.pt-BR.json` → `conversationSubtitle` vs `docs/CAPABILITY_MATRIX.md:~56` | O subtítulo afirma como fato: *"Esta conversa é só sua. Ninguém da sua organização vê o que você escreve aqui."* A própria matriz, na mesma integração, diz que falta *"E2E em navegador real com duas pessoas simultâneas, e prova de isolamento no servidor de verdade"*, e a M74-A diz que o cliente do Harness segue sem escopo de tenant. | É a única frase da tela que trata de privacidade, e é a que uma pessoa leiga vai levar mais a sério — ela pode escrever algo pessoal confiando nela. Afirmar privacidade absoluta antes da prova com duas pessoas viola diretamente "nunca chamar de pronto o que não foi provado". | Escrever o que está provado: *"Esta conversa é aberta com a sua entrada e só aparece para você nesta tela. Quem administra a instalação ainda pode ver os arquivos do servidor."* Voltar à frase forte quando o E2E com duas pessoas existir. |
| H7 | HIGH | `plugins/identity/i18n/pt-BR.json` → `assistant.bindingQuota` + `plugins/identity/src/service.ts:32,406` | Texto: *"Este dispositivo já tem 8 conversas abertas com o assistente. Feche ou termine uma delas para começar outra."* Dois defeitos: (a) o limite é por **sessão de identidade** (`session:${session.session_id}`), não por dispositivo — sair e entrar de novo zera, e dois navegadores no mesmo aparelho dão 16; (b) **não existe "fechar conversa"** em lugar nenhum: as rotas são `open`, `events`, `messages`, `cancel`. | A pessoa é bloqueada, recebe uma instrução impossível ("feche uma") e uma explicação errada ("este dispositivo"). Terceiro beco sem saída da tela. | Corrigir o fato e a ação: *"Você já tem 8 conversas abertas nesta entrada. Nenhum histórico foi apagado. Ainda não é possível fechar uma conversa por aqui — saia e entre de novo, ou continue em uma das conversas que já existem."* E, de verdade, oferecer encerrar uma conversa. |
| M1 | MEDIUM | `Conversation.tsx:230-235` vs `conversationApi.ts:7-8` | O evento carrega `truncated` por mensagem (texto cortado em 64 KiB, `assistant-conversation.ts:289`), mas o componente só usa `interrupted`. O corte é silencioso. | A resposta simplesmente para no meio de uma frase e a pessoa acha que o assistente travou ou que ela perdeu conteúdo. | Renderizar quando `event.truncated`: *"(mostrando só o começo desta resposta — ela é muito longa para caber aqui)"*. |
| M2 | MEDIUM | i18n `compactionMarkerTokens` = "tokens aproximados" | "token" é jargão técnico puro — na mesma família de "tenant", "seq", "T3". Aparece na frase de encerramento da compactação, exatamente no momento em que a pessoa está ansiosa. | A pessoa lê "12345 tokens aproximados" e não faz ideia se isso é bom, ruim, ou se perdeu algo. | Ou apagar o número (o `itens` já basta), ou traduzir para tamanho: *"— cerca de 12.345 pedaços de texto resumidos"*. Melhor ainda: *"Resumi 6 mensagens antigas. O conteúdo delas continua no resumo acima."* |
| M3 | MEDIUM | `AssistantEntry.tsx:63-69` + i18n `openInHarness` | Dois botões seguidos, sem hierarquia clara: "Abrir conversa" e **"Abrir no Harness (somente instalação pessoal)"**. "Harness" é o nome interno do motor — jargão. E em modo equipe o segundo botão só produz o erro `assistant.personalOnly` (`assistant-session.ts:72`). | A pessoa não sabe qual dos dois é "o certo", e metade das instalações leva um dos botões a um erro garantido. Botão que só serve para dar erro é botão que não faz nada. | Esconder o segundo botão quando ele não pode funcionar. Se tiver de aparecer: *"Abrir na janela avançada do assistente (só na instalação em um computador só)"*. Nunca "Harness". |
| M4 | MEDIUM | `Conversation.tsx:113-122` | "Organizar conversa agora" envia literalmente o texto `/compact` pela mesma rota de mensagem. Ele volta pelo journal como `message.user` e é exibido no histórico como **"Você: /compact"**. | A pessoa vê no próprio histórico uma mensagem que ela não escreveu, com aparência de comando de programador. Ela pode achar que apertou algo errado, ou tentar digitar `/compact` depois. | Filtrar do histórico a mensagem de usuário cujo texto seja exatamente o comando enviado por esse botão, e no lugar mostrar o marcador *"Você pediu para organizar a conversa."* |
| M5 | MEDIUM | `Conversation.tsx:132-146` + `styles.css:19` | O `<ol class="conversation-log">` tem `max-height:58vh; overflow-y:auto` e **nenhuma rolagem automática**. Mensagem nova entra fora da vista. Também não há horário em nenhuma mensagem, embora `at` chegue em todo evento. | Em conversa longa a pessoa fica olhando para o mesmo trecho antigo enquanto a resposta chega embaixo, invisível. Ela conclui que o assistente não respondeu. | Rolar para o fim quando chega evento novo **e** a pessoa já estava no fim (não roubar a rolagem de quem está lendo o histórico); e exibir a hora nas mensagens. |
| M6 | MEDIUM | `plugins/agents/i18n/pt-BR.json` → `recovery.required`, `recovery.liveJobs`, `recovery.incomplete`, `recovery.shutdownDeadline`; `plugins/agent-team/i18n/pt-BR.json` → `errors.reconciliationIncomplete` | Frases que chegam à pessoa pelo chat, cheias de jargão: *"ainda está reconciliando uma execução anterior"*, *"o reload foi bloqueado para não perder seu controle"*, *"não conseguiu eliminar todos os estados ativos e o serviço permaneceu bloqueado"*, *"enquanto o registro do Harness ainda informa trabalho ativo"*. Nenhuma diz o que a pessoa deve fazer. | "reconciliar", "reload", "estados ativos", "registro do Harness", "processo" — nada disso existe no vocabulário de quem não programa. E como não há ação sugerida, a pessoa fica travada sem saber se espera, se tenta de novo, ou se perdeu trabalho. | `recovery.required` → *"O DZ23 ainda está terminando de arrumar uma tarefa anterior. Espere alguns segundos e tente de novo. Nada foi perdido."* · `recovery.liveJobs` → *"Há uma tarefa em andamento agora. Espere ela terminar, ou toque em Parar, antes de recarregar."* · `recovery.incomplete` → *"O DZ23 não conseguiu arrumar sozinho uma tarefa anterior e preferiu parar a arriscar seu trabalho. Nada foi apagado. Peça ajuda a quem instalou o DZ23."* · `reconciliationIncomplete` → *"A equipe não pode continuar porque uma tarefa anterior ainda aparece como em andamento."* |
| M7 | MEDIUM | `plugins/action-approval/i18n/pt-BR.json` → `errors.routeNotFound`, `errors.methodNotAllowed`, `errors.descriptorConflict` | *"Rota não encontrada."*, *"Esta ação não é permitida neste endereço."*, *"Já existe um pedido diferente com esse mesmo identificador."* — três frases escritas em vocabulário de HTTP. As demais chaves do mesmo arquivo (`expired`, `consumed`, `denied`) estão **boas** e mostram que o autor sabe escrever para leigo. | Se um dia aparecerem na tela, a pessoa lê "rota", "endereço", "identificador" e não entende que o pedido de confirmação simplesmente não existe mais. | *"Não encontrei este pedido de confirmação."* · *"Este pedido de confirmação não aceita essa ação."* · *"Já existe outro pedido de confirmação em aberto para esta mesma ação."* |
| M8 | MEDIUM | `docs/proofs/M91-chat-compaction-proof.md` (tabela dos 12 testes) vs `compaction.spec.ts` / `Conversation.spec.tsx` | Três linhas da tabela prometem mais do que o teste faz. **Teste 3** ("reconexão depois do start e antes do end restaura a faixa") só aplica o evento `start` a um estado vazio — não há reconexão nenhuma. **Teste 11** ("`/compact` manual e automático usam a mesma máquina e o mesmo journal") monta os dois casos com **o mesmo helper**, muda o id e compara — é tautológico, não pode reprovar; o botão `/compact` não é exercitado. **Teste 12** ("acessibilidade") é `toContain('role="log"')` em HTML estático mais um `readFileSync` procurando a string `prefers-reduced-motion` na folha de estilo — e foi exatamente essa folha que produziu o achado C1. | O documento é lido como "isto foi provado". Um teste que não pode reprovar é uma prova falsa, e neste caso a "prova de acessibilidade" convive com um contraste de 1,05:1. | Renomear as três linhas para o que elas realmente asseguram ("a faixa é reconstruída a partir dos eventos", "a projeção não depende de quem disparou", "os atributos ARIA estão presentes na marcação"), e mover a acessibilidade real para o Playwright + axe que já existe em `apps/studio-web/tests`. |
| M9 | MEDIUM | `docs/CAPABILITY_MATRIX.md:9`, linha "Cancelamento de delegação após reinício" e linha "Conversas do Assistente em instalação multiusuário" | A M75-B escreve, com todas as letras, `NOT_IMPLEMENTED: rota HTTP ou tela para resolveUnknownRun … Enquanto não tiver, aqueles arquivos ficam reservados` — honestidade exemplar. Mas a coluna "Falta" da matriz só lista *"reinício real no Windows, operação prolongada e backend distribuído"*. O beco sem saída sumiu. O mesmo vale para a linha da conversa multiusuário, que não menciona que um pedido de confirmação não tem resposta na tela (C2). | A matriz é o documento que o dono do produto lê para decidir. Quem lê só a matriz conclui que a única coisa faltando é "Windows e operação prolongada", e não que existem estados dos quais a pessoa não sai. | Acrescentar às colunas "Falta": *"não existe saída pela interface para uma execução em estado desconhecido — os arquivos ficam reservados"* e *"um pedido de confirmação de ação aparece na tela mas não pode ser respondido por ela"*. |
| M10 | MEDIUM | `Conversation.tsx:160` | O botão **"Tentar de novo"** só faz `setAttempt(v => v + 1)`, que reinicia a **leitura** do histórico. Depois de uma falha de envio recuperável (5xx/429), ele não reenvia nada. | A pessoa clica em "Tentar de novo" esperando que a mensagem vá; o aviso some (por H1) e nada acontece. Botão que parece agir e não age. | Ou o botão reexecuta a última ação que falhou, ou muda de nome conforme o caso: "Recarregar a conversa" para falha de leitura, "Enviar de novo" para falha de envio. |
| L1 | LOW | `Conversation.tsx:169-175` | O `<textarea>` não envia com Enter; só o botão envia. Não há dica disso. | Todo mundo aprendeu em aplicativo de mensagem que Enter envia. A pessoa vai apertar Enter, ganhar uma linha em branco, e repetir. | Enviar com Enter, quebrar linha com Shift+Enter, e dizer isso em texto pequeno abaixo do campo. |
| L2 | LOW | `AssistantEntry.tsx:18,42` | O `conversationId` mora só no estado do React. Recarregar a página, ou usar o "voltar" do navegador, devolve a pessoa ao cartão de entrada. | A pessoa acha que perdeu a conversa (ela não perdeu: "Abrir conversa" reaproveita a mesma sessão — mas a tela não diz isso). | Guardar o id na URL (`/studio/assistente/:id`) e, no cartão, dizer *"Você já tem uma conversa aberta — continuar de onde parou."* |
| L3 | LOW | `conversationState.ts:54` | `truncated: state.truncated \|\| snapshot.truncated` é grudento: uma vez verdadeiro, o aviso "Mostrando as mensagens mais recentes" nunca mais sai, mesmo que a conversa volte a caber. | Aviso permanente vira ruído e a pessoa para de ler os avisos da tela — inclusive os importantes. | Usar o valor do snapshot atual. |
| L4 | LOW | `Conversation.tsx:150-162` | O aviso de erro tem `role="alert"` (correto) mas o foco nunca vai para ele nem para o botão de retentar; e o `<ol role="log">` não ganha `aria-busy` enquanto o turno está em andamento. | Quem usa leitor de tela ouve o alerta, mas depois precisa caçar o botão com Tab a partir de onde estava. E não é avisado de que o assistente ainda está trabalhando. | Mover o foco para o botão de retentar quando um erro de ação aparece, e marcar `aria-busy={status !== 'idle'}` no log. |
| I1 | IMPROVEMENT | `Conversation.tsx:169` | Não há indicação de tamanho máximo antes de o servidor recusar (32 KiB). | A pessoa só descobre o limite errando. | Contador discreto que só aparece perto do limite: *"Sua mensagem está ficando muito longa."* |
| I2 | IMPROVEMENT | `AssistantEntry.tsx` / `Conversation.tsx` | Só existe "a conversa". Não há lista, nome, nem histórico de conversas — mas o servidor permite até 8 por sessão (H7). | A pessoa não consegue voltar a uma conversa antiga, nem entende por que existe um limite de 8 de algo que ela nem sabe que tem. | Ou mostrar as conversas existentes e deixar nomeá-las, ou assumir uma conversa só e alinhar o limite a isso. |

---

# Resposta item por item

## 1. Toda frase que uma pessoa lê

Revisei as **90 chaves novas ou alteradas** do `git diff f1677b4..HEAD -- '*i18n*'`
em seis catálogos.

**O que está bom, e merece ser dito.** A maior parte deste conjunto está acima
da média do mercado brasileiro de software. Exemplos que eu não mudaria:

- `compactionFailed`: *"Não foi possível organizar a conversa. Nada foi perdido."*
  — diz o que aconteceu e responde à única pergunta que importa, na mesma frase.
- `compactionStepReconciling`: *"Ainda organizando. Nada foi perdido."* — é o
  estado em que seria mais fácil mentir "concluído", e o código escolheu não
  mentir.
- `recovery.unknownExternal`: *"O DZ23 STUDIO reiniciou enquanto um assistente
  externo trabalhava nesta cópia. Ele não consegue provar que aquele programa
  terminou, então preservou tudo e bloqueou estes arquivos até alguém
  confirmar."* — explica a causa, a decisão e a consequência sem uma palavra
  técnica. É o padrão que o resto deveria seguir.
- `errors.expired`: *"O tempo para confirmar esta ação terminou. Peça de novo com
  calma."* — o "com calma" é uma escolha humana e correta.
- `assistant.interfaceUnavailable`, `errors.consumed`, `agent-team/status.processLost`:
  todos dizem o estado **e** o destino do trabalho.

**Jargão encontrado** (frases piores escritas acima, com a versão melhor):
`tokens` (M2), `Harness` (M3), `JSON` (H5), `reconciliar / reload / estados
ativos / processo` (M6), `rota / endereço / identificador` (M7).

**Frases que não dizem o que fazer agora**: `recovery.incomplete`,
`recovery.required`, `errors.reconciliationIncomplete`, `assistant.conversationMissing`.

**Frases que pedem algo impossível**: `assistant.bindingQuota` (H7) e
`recovery.blockedByUnknown` (C3). Essas duas são as mais graves do catálogo,
porque uma frase impecável que manda a pessoa apertar um botão inexistente é
pior do que jargão.

**Frase que promete mais do que foi provado**: `conversationSubtitle` (H6).

Não encontrei nenhuma ocorrência de "tenant", "fingerprint", "CSRF", "claim",
"lease", "T3" ou "seq" em texto voltado à pessoa — as chaves com `Audit` no nome
(`bindingConflictAudit`, `bindingQuotaAudit`) ficam no registro interno, o que
está certo. Isso é disciplina real e vale registrar.

## 2. A tela da conversa

- **Primeira vez (vazio):** existe, é honesto e explicado — `emptyTitle` +
  `emptyBody`. O teste renderiza e verifica. Único defeito: a promessa "pare a
  qualquer momento" é falsa numa janela concreta (H2).
- **Enviar:** o botão fica desabilitado com campo vazio (verificado no teste,
  linha 21 de `Conversation.spec.tsx`) — não há botão que não faz nada aqui. O
  rascunho só é limpo **depois** que o servidor aceita (`conversationState.ts:69-72`),
  o que é a decisão certa e está comentada no código. O foco volta ao campo
  depois do envio (`Conversation.tsx:96`) — bom.
- **Esperar:** a linha de status usa `role="status" aria-live="polite"` e diz
  "guardada" ou "trabalhando". Boa. Mas ela e a fila dependem de casamento por
  texto (H3).
- **Parar:** existe, mas some justamente durante a fila (H2). Um erro do "Parar"
  desaparece em 1,5 s (H1).
- **Erro:** existe com `role="alert"` — mas some sozinho (H1), pode mentir
  "Conversa não encontrada" numa queda passageira (H4), pode falar JSON (H5), e
  o botão de retentar não retenta o que falhou (M10).
- **Reconectar:** a leitura é um `setInterval` de 1,5 s com `AbortController`; o
  merge de snapshot é idempotente e monotônico (`applySnapshot`) e isso está bem
  feito e bem testado. Não há indicação visual de "sem conexão" — a pessoa só vê
  a mensagem de erro piscar.
- **Conversa longa:** sem rolagem automática e sem horário (M5); corte de 500
  eventos avisado, corte de 64 KiB por mensagem **não** avisado (M1).
- **"A pessoa sabe se a mensagem dela foi guardada?"** — a intenção está certa e
  documentada no código, mas a resposta honesta hoje é **não em todos os casos**:
  duas mensagens iguais (H3) e erro que evapora (H1) quebram exatamente essa
  garantia.
- **Botão que não faz nada / beco sem saída:** sim — o pedido de confirmação (C2).

## 3. A faixa de compactação

**Esta é a melhor parte da entrega e eu não tenho achado grave contra o
mecanismo.** Verifiquei linha a linha:

- A barra é indeterminada e `aria-valuenow` está **ausente de propósito**, com o
  motivo escrito no código (`Conversation.tsx:196-201`): os eventos upstream não
  carregam unidade de progresso. Isso é recusar-se a inventar evidência.
- `RECONCILING` (`conversationState.ts:154-156`) existe justamente para o caso em
  que seria fácil dizer "concluído" sem saber. Testado (teste 4).
- As contagens só aparecem **depois** que o resumo realmente as informou, e o
  marcador silencia quando não há contagem (teste 12, `silent`).
- Os testes 1, 2, 4, 5, 6, 7, 8, 9, 10 são de verdade e podem reprovar. Rodei:
  34 testes passam.

**A promessa "nada foi perdido" é verdadeira no código?** Para a compactação,
sim, com uma ressalva importante: o Studio **não compacta** — ele projeta os
marcadores do Harness; o resumo chega como mensagem normal e a mensagem em voo é
preservada na fila (teste 6) e o rascunho sobrevive (teste 7). Nesse escopo a
frase é honesta. A ressalva é que "nada foi perdido" é dita pelo **cliente**
sobre um processo que roda no servidor: se o Harness perder algo, esta tela não
tem como saber e dirá "nada foi perdido" mesmo assim. `NÃO VERIFICADO` — só um
teste de ponta a ponta com o Harness real fecharia isso, e a própria prova M91
diz que ele está `NOT_EXECUTED`. Isso está declarado, então não é desonestidade;
é lacuna assumida.

Defeitos ligados à faixa, e menores: "tokens" (M2), o `/compact` visível no
histórico (M4), e as três linhas superdimensionadas da tabela de provas (M8).

## 4. Acessibilidade

**Presente e correto:** `role="log"` + `aria-live="polite"` + `aria-relevant="additions"`
no histórico; `role="status" aria-live="polite"` na linha de estado e na faixa;
`role="alert"` no erro; `<label for="conversation-draft">` amarrado ao `id` do
campo; ícones com `aria-hidden="true"` e texto ao lado em todo botão;
`:focus{outline:3px solid #9fc3ff;outline-offset:2px}` visível em campo e botões;
`prefers-reduced-motion` desliga a animação da barra e a substitui por uma barra
estática (`styles.css:53`), o que é a implementação correta e não a preguiçosa;
`aria-label` na barra e ausência deliberada de `aria-valuenow`; `body{min-width:320px}`,
`.conversation{min-width:0}`, `overflow-wrap:anywhere` e `flex-wrap` nas ações —
a 320 px os botões empilham e o texto longo quebra, sem rolagem horizontal.

**O que falta:**
- **Contraste em modo escuro: reprovado** (C1) — 1,05:1, 1,12:1, 1,03:1 medidos.
  Este é o achado de acessibilidade mais grave e é o único que torna a tela
  inutilizável.
- Contraste em modo claro: **aprovado**, medido — `#5c6881`/branco 5,60:1;
  `#075ee5`/branco 5,61:1; `#b42318`/branco 6,57:1; `#4a5876`/`#f6f8fc` 6,70:1.
- Ordem de leitura: título → aviso de corte → histórico → faixa → estado → erro →
  formulário. Correta e lógica. Mas **o erro fica depois do histórico e antes do
  campo**, e o foco não vai até ele (L4).
- Sem `aria-busy` no log durante o turno (L4).
- Sem rolagem automática (M5) — atinge em cheio quem usa ampliação de tela.
- `NÃO VERIFICADO`: navegação real por teclado, leitor de tela real e ampliação
  a 200%. Sem navegador, só posso ler a marcação estática. O projeto já tem
  `@axe-core/playwright` instalado; ele não foi usado nesta fatia.

## 5. Estados vazios, carregando e de erro

- **Vazio:** existe e é honesto (com a ressalva H2).
- **Carregando:** existe para o turno ("O DZ23 está trabalhando…") e para a fila.
  **Não existe** para a primeira leitura: entre abrir a tela e o primeiro
  snapshot chegar, a pessoa vê o estado vazio "Ainda não há mensagens" — que numa
  conversa que já tem histórico é **falso**. Achado embutido em M5/L4; sugiro um
  estado inicial *"Carregando sua conversa…"* que só vira "Ainda não há mensagens"
  depois do primeiro snapshot bem-sucedido.
- **Erro:** existe, mas é o estado mais frágil da tela — H1, H4, H5, M10.

## 6. Honestidade dos documentos

**O que está honesto e deve ser preservado:**
- `M75B-external-worker-proof.md` declara o próprio beco sem saída
  (`NOT_IMPLEMENTED: rota HTTP ou tela para resolveUnknownRun … Digo isso em vez
  de omitir`). Isso é exatamente a régua do projeto sendo cumprida.
- `M90A-action-approval-proof.md` declara `NOT_IMPLEMENTED: montagem em perfil e
  emissão de pedidos por um serviço consumidor real. Esta fatia entrega a
  autoridade, não o consumidor.` Confirmei no código: o plugin não está montado.
- `M91-chat-compaction-proof.md` fecha com *"Falta a prova que nenhum teste pode
  dar… Mock visual não fecha este gate, e este documento não afirma que fechou."*
- `INTEGRATION-CANDIDATE-20260907.md` relata 3 reprovações, o lock de release
  defasado e a limitação do próprio diretório de trabalho.

**Onde o documento soa mais pronto do que é:**
- **M8** — três dos "12 testes obrigatórios" do M91 não sustentam a frase da
  tabela; o teste 11 é tautológico e não pode reprovar; o teste 12, rotulado
  "acessibilidade", é verificação de string e convive com contraste 1,05:1.
  **Este é o achado grave desta seção**: um documento diz "provado" onde o teste
  correspondente não pode falhar.
- **M9** — a `CAPABILITY_MATRIX` omite, nas colunas "Falta", os dois becos sem
  saída que as provas individuais registram. A matriz é o documento de decisão;
  omitir ali desfaz a honestidade das provas.
- **H6** — a interface afirma privacidade num grau que a matriz declara não
  provado. Documento honesto, tela otimista: a tela é o que a pessoa lê.

## 7. Funcionalidade incompleta exposta

Três estados dos quais **não há saída pela interface**, todos verificados:

1. **Pedido de confirmação** (C2) — a tela diz "Aguardando sua confirmação" e não
   existe nenhuma rota, botão ou ferramenta para confirmar. O plugin que faria
   isso existe e não está montado.
2. **Execução em estado desconhecido** (C3) — a mensagem manda "resolver aquela
   execução"; `resolveUnknownRun` não tem rota, tela nem ferramenta no catálogo
   de 13. Os arquivos ficam reservados indefinidamente.
3. **Cota de 8 conversas** (H7) — a mensagem manda "fechar ou terminar uma"; não
   existe fechar conversa.

Mais dois de menor gravidade: o botão "Abrir no Harness" que em modo equipe só
produz erro (M3), e o "Tentar de novo" que não tenta de novo o que falhou (M10).

---

## O que eu diria ao Prado, em uma frase

O motor está bem-feito e os documentos, no geral, dizem a verdade — mas a tela
ainda promete três coisas que não cumpre (confirmar, fechar, resolver), some com
o aviso de erro antes de a pessoa ler, e fica ilegível em qualquer celular no
modo escuro. Corrigidos C1, C2, C3, H1 e H2, isto vira uma tela que eu colocaria
na frente de uma pessoa leiga.
