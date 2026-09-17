# ADR-051 — A tarefa é uma conversa, e continuar nela não recomeça nada

- Estado: Aceita
- Data: 2026-09-17
- Decisor: Leandro Marcos Prado
- Fonte: decisão de produto `DZ23-VISUAL-VIDEO-20260916-R1`
- Complementa: ADR-050 (que trocou a casca e a home; esta troca a tarefa)

## Contexto

A ADR-050 trocou a casca e a home. A tarefa continuou sendo a mesma tela de
antes: um relatório no meio, um trilho de cinco caixas numeradas à direita, e
painéis azul-marinho ocupando a altura inteira. O proprietário recusou a
captura com uma frase que não deixa dúvida sobre o que ele estava vendo:

> "Ela ainda apresenta o assistente antigo de cinco etapas como estrutura
> principal."

E, no pacote de correção, a régua: **"Trocar o nome de um componente para
WorkspaceShell não é critério de aceite."**

Havia também um defeito funcional junto, e ele é mais grave que a aparência:
**não existia como continuar uma tarefa.** A única caixa de texto do produto
era a da home, e usá-la criava outra tarefa. Pedir "deixe o botão verde" depois
de ver o resultado significava recomeçar do zero, com outro identificador,
outro histórico e outro gasto.

## Decisão

**1. A estrutura principal da tarefa é a CONVERSA.** Histórico legível na
coluna central, compositor no rodapé com o mesmo alinhamento, painéis sob
demanda ao lado. O trilho numerado de cinco etapas não é montado.

**2. O pipeline de cinco fases continua inteiro, como lógica interna.** Ele não
foi reescrito, reduzido nem substituído. Perguntas e plano passam a aparecer
como lances da conversa; o progresso é compacto; o detalhamento antigo —
resultado, relato da tentativa, pontos seguros e o próprio trilho — abre num
painel lateral, sob demanda.

**3. A conversa é uma PROJEÇÃO do que já existe.** Nenhum diário, executor ou
armazenamento paralelo foi criado. `GET /projects/:id` já devolvia pedido,
turnos de admissão, plano, tentativas e evidências no mesmo corpo; o que
faltava era apresentação, não armazenamento. A projeção mora em funções puras
(`tarefa/transcricao.ts`, `tarefa/compositor.ts`) porque a ordem dos lances e a
decisão do envio são o que quebra primeiro quando alguém acrescenta um estado —
e uma decisão dentro de um JSX não é exercitada por teste nenhum.

**4. Continuar a tarefa acontece na MESMA tarefa.** `POST
/projects/:projectId/revise` recebe o texto do compositor, incorpora-o à
especificação como critério de aceite (`origin: 'edit'`, que já existia no
esquema para este caso) e devolve o projeto a `SPEC_READY`. A versão do domínio
não sobe: nenhum registro muda de forma.

O mapa de transições da revisão é **separado** do mapa normal e do mapa de
desfazer, pelo mesmo motivo que fez o segundo existir: alargar o mapa normal
daria ao pipeline um caminho de volta de qualquer desfecho para o planejamento.

**5. A revisão não aprova nada.** Depois dela a pessoa vê o plano novo e o
aprova, como sempre. Uma revisão que gerasse sozinha seria gasto sem ninguém
olhar — e a decisão de produto diz, com todas as letras, que a política de
aprovação não é enfraquecida.

**6. Ausência de função vira destino com pendência declarada, não linha
apagada.** A regra anterior deste repositório era "sem tela, sem linha no
trilho". Ela produziu um trilho com três itens onde a referência tem seis. A
regra nova, do proprietário: *"ausência de função significa implementar e
manter a pendência; não remover o requisito para chamar o visual de completo"*.
Agendado tem endereço real, uma tela que diz que a função não existe e o que
falta para existir, e `DISPONIBILIDADE.agendado = 'pendente'` num registro que
um teste alcança. **Isso não conta como capacidade entregue.**

## Consequências

- A tela de perguntas com título grande e caixa própria deixou de existir: a
  pergunta é um lance e a resposta vai pelo compositor. Os testes que a
  exercitavam foram reescritos para o caminho novo, com mapa de equivalência,
  sem perder asserção.
- `Questions`, `Action` e `Verification` perderam a moldura de tela (`task-card`,
  `heading`) e as ações duplicadas. Nenhuma capacidade saiu; o que saiu foi a
  segunda cópia de cada coisa.
- O casador de caminhos do `prompt-to-app` passou a ser **derivado** do contrato
  de rotas. Eram duas listas descrevendo o mesmo conjunto, e elas discordaram
  em silêncio: `POST /revise` foi declarado, ganhou tratamento e respondeu 404.
- `GET /projects/:id` passou a devolver a pergunta aberta e os pedidos de
  mudança. As duas coisas são **derivadas** de registros existentes, pelas
  mesmas funções que os outros caminhos usam.

## O que esta decisão NÃO decide

- **Semelhança visual não é declarada aqui.** As capturas e a gravação em
  `apps/studio-web/capturas/` saem do build entregue e existem para comparação
  com os quadros da referência. O aceite é do proprietário.
- **Nada sobre geração com IA real.** As provas desta entrega usam construtor
  dublê no servidor de teste. `EB-04` continua aberto.
- **Nada sobre o runtime Cordis.** Não há Docker neste ambiente, e captura em
  servidor de teste não é prova de perfil.
- **Nada sobre publicação.** Nenhum deploy, release ou despesa foi autorizado
  nem executado.
