# Fatia — OS-108: os menus do compositor, com o que ESTE Studio tem ligado

## 1. O que F08/F09 pedem, e o que é honesto entregar

A referência mostra menus ancorados no compositor: ícones dos provedores, uma
lista do que está ligado e "Conectar" ao lado do que não está.

Os ícones daquelas contas **não** foram copiados. São serviços que este Studio
não conectou, e desenhá-los seria o dado encenado que a decisão do proprietário
proíbe. O que entrou é o que existe: as integrações registradas no Hub, com o
estado verdadeiro de cada uma, em dois menus — **Habilidades** e **Plugins** —
que são os mesmos dois destinos da lateral.

## 2. As regras que têm teste, e por que elas são funções

| regra | por quê |
| --- | --- |
| ligadas primeiro | é o que vale NAQUELE envio, e é o que a pessoa procura |
| corte em seis | um menu com trinta linhas é a tela inteira |
| a contagem é sobre a lista INTEIRA | mostrar seis e escrever "6" para quem tem nove ligadas seria mentir sobre o envio |
| escopo vindo de `ESCOPO` | repetir a lista de tipos aqui faria os dois discordarem no primeiro tipo novo |
| lista vazia DIZ que está vazia | nenhuma integração de exemplo |
| `null` não mostra número | "ainda não li" é diferente de "não há nenhuma": escrever "0" antes de perguntar é afirmar sem ter olhado |

Todas moram em `menusDoCompositor.ts`, exportadas. Ordem e corte dentro de um
JSX não são exercitados por teste nenhum — a lição que esta casa já pagou mais
de dez vezes.

## 3. O que NÃO entrou

**F10, o seletor de computador.** `AT-07` e `GEN-06` são AUSENTE: não existe
ligação a uma pasta do computador. Desenhar o menu com "Adicionar pasta local"
seria exatamente o botão mudo que as duas últimas fatias recusaram. O trabalho
real é `V7-F`.

## 4. Falsificação

| sabotagem | resultado |
| --- | --- |
| tirar a ordenação "ligadas primeiro" | **PEGA** |
| contar as ligadas só entre as que cabem no menu | **PEGA** |

## 5. Provas

| prova | resultado |
| --- | --- |
| `menusDoCompositor.spec.ts` | 9 |
| suíte `studio-web` | 640 |
| e2e com axe, no Chromium da CI | menu abre, `aria-expanded` muda, `Gerenciar` aponta para o destino real, `Esc` fecha, **zero violações** |
