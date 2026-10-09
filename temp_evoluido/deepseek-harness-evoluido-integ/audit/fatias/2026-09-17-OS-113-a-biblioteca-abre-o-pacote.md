# Fatia — OS-113: a Biblioteca abre o pacote, e um laço de 621 requisições caiu junto

## 1. A ação nova que a pessoa consegue concluir

**Ver o que tem dentro de um pacote sem baixá-lo.** A Biblioteca listava
pacotes e o único gesto possível era baixar um `.zip` para descobrir o que
havia lá — o que, para quem não programa, é abrir um arquivo compactado no
computador só para conferir se é o certo.

Agora o pacote abre na própria tela: os arquivos, os tamanhos, o total, e
quantos ficaram de fora do corte. O download continua ao lado — a prévia não
substituiu a operação que já existia.

## 2. Por que ESTA operação, e não outra

A declaração da OS-110 nomeou seis operações ausentes. A escolha foi a única
cujos **pré-requisitos já existiam**:

| operação | pré-requisito | estado |
| --- | --- | --- |
| **prévia** | ler o pacote que já está no disco | **existia** — `exportFile` (caminho confinado) e `readZip` |
| enviar | armazenamento de upload, validação de tipo/tamanho, proteção de travessia | não existe |
| compartilhar | destinatário, escopo, expiração, revogação | não existe |
| versões | conceito de versão do mesmo pacote | não existe |
| apagar | **autorização do dono** — ação destrutiva | não concedida |
| retenção | política | não existe |

## 3. Um leitor só, e não dois

`readZip` descompacta tudo, e pode segurar meio gigabyte para responder a uma
pergunta que o diretório central já responde. O atalho seria escrever um leitor
leve ao lado — e um segundo leitor de formato hostil é exatamente onde a
conferência estrutural diverge em silêncio.

Em vez disso, a conferência foi **extraída**: `zipHeaders` percorre e valida,
`readZip` inflaciona em cima dela, `listZip` só mapeia. As 296 provas do plugin
continuaram passando depois da extração, que é o que diz que ela preservou o
comportamento.

**O caminho da prévia é o mesmo do download** — `exportFile`, que resolve por
caminho real, recusa o que estiver fora da pasta de exportação, abre sem seguir
link e confere que é arquivo regular no próprio descritor. Uma segunda
resolução de caminho aqui seria a janela que aquele cuidado fecha.

Teto próprio: um pacote acima de 32 MiB é **recusado em palavras**, com a frase
que manda baixar. O download transmite em fluxo e não tem teto; a prévia precisa
do fim do arquivo e leria tudo.

## 4. O que a prévia encontrou de quebrado

Ao medir por que o botão sumia entre duas asserções, apareceu um defeito que
não era meu:

```
CHAMADAS_EM_3s = 621
```

`BibliotecaScreen({ api = createHubApi() })` criava um cliente **novo a cada
render**. `ler` dependia dele, o efeito dependia de `ler`, e o efeito chamava
`setAcervo` — cada render disparava outra leitura. **621 chamadas a `/exports`
em três segundos, numa tela parada.**

A tela desenhava certo o tempo todo. O defeito só cobrava a conta do servidor,
da bateria e da rede de quem deixasse a Biblioteca aberta. Depois do conserto:
**1**.

A guarda é uma **contagem** no e2e, e não uma captura: o que ela pega é a ordem
de grandeza do laço.

## 5. Um acerto de acessibilidade no caminho

O botão trocava o rótulo para "Fechar" ao abrir. Parece natural e é pior: quem
ouve a tela recebe a mesma informação duas vezes e perde a referência do que
aquele botão controla. O nome ficou **estável** e o estado vai em
`aria-expanded`, que é o padrão ARIA de divulgação.

## 6. Falsificação

| sabotagem | resultado |
| --- | --- |
| a lista volta a descompactar tudo | **SOBREVIVEU** — o teste comparava saída, e só o custo muda → virou um teste com o payload corrompido: ilegível para quem descompacta, listável para quem lê o diretório. **Agora é pega** |
| cortar sem dizer quantas sobraram | **PEGA** |
| total do que coube em vez do total do pacote | **PEGA** |
| o cliente do Hub volta a nascer por render | **PEGA** pelo contador do e2e |

## 7. Provas

| prova | resultado |
| --- | --- |
| `previa-do-pacote.spec.ts` | 6 |
| `previa.spec.ts` (tela) | 5 |
| suíte do `integration-hub` | 297, com a extração do leitor no meio |
| suíte `studio-web` | 663 |
| e2e nos quatro tamanhos, com axe | o pacote abre, lista três arquivos, fecha no mesmo botão, **zero violações**, e a contagem de leituras fica em ordem de grandeza unitária |

**Limitação declarada:** o armazenamento do acervo no servidor de teste é
**dublê**. O que **não** é dublê é o formato: o `.zip` é montado pelo
`createZip` de produção e lido pelo `listZip` de produção. Enviar, versões,
compartilhamento, retenção e apagar continuam **ausentes**, e a declaração da
tela continua dizendo isso.
