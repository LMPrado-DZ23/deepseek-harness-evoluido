# Fatia — OS-106: as Preferências, com a verdade ao lado de cada item

## 1. O que o quadro F04 pede, e o que este produto tem

A referência mostra treze itens em três grupos. Desenhar os treze funcionando
seria mentira; desenhar só cinco seria esconder o resto. O modal mostra **os
treze**, e cada um carrega o que ele é:

| grupo | item | aqui |
| --- | --- | --- |
| Configurações | Conta | **funciona** — nome da sessão |
| Configurações | Notificações | **funciona** — o mesmo controle do sino, agora com espaço para explicar |
| Configurações | Tema | **pendência declarada** — ver §2 |
| Configurações | Idioma | **pendência declarada** — o Studio fala pt-BR e só ele; um seletor com um idioma é botão que não faz nada |
| Configurações | Atalhos | **pendência declarada** — só existe `Esc`, que fecha painéis |
| Configurações | Uso e custos | **pendência declarada** — T-35; um número aqui seria inventado |
| Capacidades | Habilidades | **funciona** — leva ao destino real |
| Capacidades | Plugins | **funciona** — leva ao destino real |
| Capacidades | Meu computador | **pendência declarada** — V7-F |
| Dados | Biblioteca | **funciona** — leva ao destino real |
| Dados | Controles de dados | **pendência declarada** — a exportação por projeto está na Biblioteca |
| Dados | Implantações | **pendência declarada** — publicar o app gerado não existe |

**Item indisponível não desenha controle nenhum.** Ele vira uma frase com
título "Ainda não disponível" e o motivo. A decisão do proprietário proíbe
botão mudo por escrito, e um `disabled` cinza é um botão mudo com aparência de
desculpa.

A regra mora em `secoesDePreferencias` e `podeOperar`, com teste — e não num
`if` dentro do JSX, que é como o botão mudo entrou neste produto da primeira
vez.

## 2. O tema claro foi MEDIDO, e por isso não foi entregue

`styles.css` tem **506 cores em hexadecimal fixo** fora dos tokens, contra 106
usos de token em `tarefa.css` e 71 em `shell.css`. Um seletor de tema hoje
pintaria as telas novas e deixaria as antigas escuras — metade da interface
trocando e metade não.

Isso é pior do que não ter tema claro, então a seção **declara a pendência** e
a migração virou `V7-K` no DAG, com o número medido dentro.

Medir antes de construir é a regra desta casa. Aqui ela evitou entregar um
seletor que funcionaria só na captura.

## 3. Falsificação

| sabotagem | resultado |
| --- | --- |
| `podeOperar` devolve sempre `true` | **PEGA** — o e2e conta os controles dentro da seção Tema no navegador de verdade |
| seção indisponível sem `pendencia` | **PEGA** — "ainda não existe" sem motivo é indistinguível de quebrado |

## 4. Provas

| prova | resultado |
| --- | --- |
| `preferencias.spec.ts` | 10, inclusive a conferência de que TODA pendência e TODO título têm frase no catálogo |
| suíte `studio-web` | 631 |
| e2e no Chromium da CI, com axe | Preferências abrem, **zero violações**, `Esc` fecha, o destino é o endereço real |

**Limitação declarada:** os menus ancorados no compositor (F08–F10) **não**
entraram nesta fatia. O de conectores e o de habilidades saem dos destinos que
já existem; o seletor de computador continua AUSENTE, e desenhá-lo seria o
botão mudo que esta mesma fatia recusa. `V7-A` segue PARCIAL por isso.
