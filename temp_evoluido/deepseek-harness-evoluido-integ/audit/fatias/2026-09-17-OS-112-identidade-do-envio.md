# Fatia — OS-112: reenviar depois de perder a resposta não duplica mais nada

## 1. A ação nova que a pessoa consegue concluir

**Reenviar uma pergunta ou um pedido de alteração depois de perder a resposta —
e continuar com uma mensagem só.** Antes desta fatia, quem perguntava, perdia a
resposta por tempo esgotado e apertava de novo ficava com **duas mensagens
iguais** na conversa; quem pedia uma alteração ficava com **duas revisões**,
cada uma com um plano para aprovar e uma tentativa para gastar.

A mesma garantia vale para duas abas abertas ao mesmo tempo e para a queda do
processo no meio da gravação.

## 2. A diferença que o dono mandou separar

A criação de tarefa já tinha identidade de intenção desde `UX-02`. **Os envios
seguintes não tinham.** São coisas diferentes e agora estão explicitamente
separadas:

| envio | identidade | desde |
| --- | --- | --- |
| criar tarefa | `impressaoDaCriacao` (`v1:`) | UX-02 |
| perguntar | `impressaoDoEnvio` (`e1:`), com tipo + tarefa + texto | **esta fatia** |
| pedir alteração | idem | **esta fatia** |

**Não há segunda contabilidade.** É o mesmo mecanismo: reserva durável gravada
ANTES do efeito, serializada pelo mesmo mutex, com os mesmos três desfechos. Um
segundo mecanismo discordaria do primeiro no conserto seguinte.

O TIPO entra na impressão porque perguntar e pedir alteração são gestos
diferentes: sem ele, quem perguntasse "trocar o cabeçalho" e depois PEDISSE
trocar o cabeçalho receberia a resposta da pergunta no lugar da revisão.

## 3. O que foi provado

| garantia | prova |
| --- | --- |
| mesmo envio, mesma chave → um efeito | serviço + rota + e2e depois de RELOAD |
| mesma chave, texto diferente → **409**, e não o efeito antigo | serviço + rota |
| dois envios **concorrentes** → um efeito | `Promise.all` no serviço, para pergunta e para revisão |
| a chave **não é credencial** | outra pessoa com a mesma chave ganha o efeito dela; a reserva é conferida contra o ator |
| **queda entre as duas escritas** | o reenvio TERMINA o efeito com o MESMO identificador, em vez de criar um segundo |
| o reenvio **não grava uma segunda aprovação** | a auditoria conta uma decisão onde a pessoa tomou uma |
| sem chave, dois envios continuam sendo dois | o histórico de quem repete de propósito é preservado |
| a **autorização não foi enfraquecida** | a releitura passa pelo mesmo `project()`/`specs()` que reautoriza |

Do lado da tela, a regra de quando pedir chave nova é a mesma da home e mora no
mesmo módulo: **reenviar o mesmo texto reaproveita a chave; corrigir o texto
gera outra** — senão quem só quis corrigir seria recusado por conflito. Espaço
repetido não é outro envio.

## 4. Sobre custo — o que o dono cobrou explicitamente

> "Não criar tentativa de construção não equivale a custo zero."

Perguntar, hoje, **não chama modelo nenhum**: a resposta é montada do estado
persistido, e o turno é gravado com `route: null` e `model: null` justamente
para não afirmar uma chamada que não houve. Enquanto for assim, não há uso a
registrar — e é por isso que o painel de uso não ganha linha nenhuma por
pergunta. **No dia em que perguntar chamar um modelo, o registro de uso passa a
ser obrigatório nesse caminho**, e isso está anotado em `T-35`.

## 5. Falsificação

| sabotagem | resultado |
| --- | --- |
| tirar o TIPO da impressão | **PEGA** |
| ignorar a reserva e sempre executar | **PEGA**, em 6 testes |
| não conferir o escopo da reserva | **PEGA** |

## 6. Provas

| prova | resultado |
| --- | --- |
| `identidade-do-envio.spec.ts` | 14 |
| `http.spec.ts` | 39, com 3 novos |
| `creationIntent.spec.ts` | 10, com 5 novos |
| suíte do plugin | 1114 |
| e2e da jornada, no Chromium da CI | reenvio depois do resultado, **uma** mensagem depois do reload |

**Limitação declarada:** `/plan/change` e `/intake/answer` ainda **não** têm
identidade de envio. Eles não duplicam efeito visível hoje — a resposta de
admissão é idempotente por `question_id` e a mudança de plano é um estado —,
mas isso é argumento, não prova, e está anotado como pendência de `V7-C`.
