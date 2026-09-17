# Fatia — OS-110: a Biblioteca declara o que guarda e o que faz

## 1. A exigência

Do proprietário, por escrito: *"a Biblioteca precisa declarar exatamente quais
arquivos e operações ela suporta"*. E, antes dela: *"Biblioteca não é um apelido
para Projetos"*.

A tela listava pacotes e não dizia o que ela é. Quem chega supõe que dá para
subir arquivo, versionar, compartilhar e apagar — e descobre que não dá na hora
em que precisa. Uma lista sem declaração é uma promessa implícita.

## 2. A declaração

**Ela guarda:** o pacote `.zip` que uma tarefa produz quando você exporta o
resultado — e só ele. No singular, de propósito: "seus arquivos" sugeriria que
ela aceita qualquer coisa.

**Ela faz:** listar os pacotes de todas as tarefas do mais recente ao mais
antigo; filtrar por tarefa; baixar; e conferir tamanho, número de itens, data e
resumo SHA-256.

**Ela ainda NÃO faz** — cada uma com o motivo:

| operação | motivo |
| --- | --- |
| receber arquivos enviados | não existe envio de arquivo neste produto |
| prévia sem baixar | não existe leitor de pacote |
| versões do mesmo pacote | cada exportação é um pacote novo, com data e resumo próprios |
| compartilhar | compartilhar é operação de acesso — destinatário, escopo, expiração, revogação — e nada disso existe |
| apagar por aqui | ação destrutiva; exige decisão explícita do dono, e não foi autorizada |
| retenção ou expiração | não há política |

## 3. Por que é um módulo, e não um parágrafo

Porque a declaração é uma **promessa**. Um parágrafo escrito à mão dentro do
JSX envelhece sem ninguém notar, e a promessa passa a ser falsa em silêncio —
que é a forma mais barata de mentir numa interface.

`biblioteca.ts` é pura e tem teste, inclusive de que **toda** operação não
suportada tem motivo e **toda** frase existe no catálogo. Uma operação nova sem
motivo, ou sem texto, reprova.

## 4. Falsificação

| sabotagem | resultado |
| --- | --- |
| operação não suportada sem motivo | **PEGA** |
| operação nova sem frase no catálogo | **PEGA**, em 2 testes |

## 5. Provas

| prova | resultado |
| --- | --- |
| `biblioteca.spec.ts` | 6 |
| e2e com axe | a região existe, contém `.zip`, mostra as DUAS colunas e o motivo do "não"; **zero violações** |

**Limitação declarada:** declarar o que falta não é implementá-lo. Receber
arquivos, prévia, versões, compartilhamento e retenção continuam **ausentes**,
e a tarefa que os constrói é `V7-B`.
