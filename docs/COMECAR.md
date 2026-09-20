# Começar

Do zero ao primeiro aplicativo. Uma página.

Se qualquer passo daqui falhar, **não haverá um *stack trace***. O Studio confere
o ambiente antes de subir e diz, em português, o que falta e o comando exato que
resolve — **um de cada vez**.

---

## 1. Baixar

```bash
git clone --recurse-submodules https://github.com/LMPrado-DZ23/deepseek-harness-evoluido
cd deepseek-harness-evoluido
```

O `--recurse-submodules` importa: o Studio é construído **sobre** o DeepSeek
Harness, que vem como submódulo fixado. Sem ele a pasta existe e fica vazia — e
é o primeiro erro que o conferidor pega.

Se você já clonou sem ele:

```bash
git submodule update --init --recursive
```

## 2. Conferir

```bash
pnpm studio:doctor
```

Ele olha o disco e não muda nada. Uma resposta possível:

```
  ok A versão do Node.js: 22.23.1
  ok O Harness fixado, baixado: o Harness está no lugar
  ok As dependências do Harness: instaladas
  ok O Harness compilado: compilado
 >>> O pacote que dá a partida: não encontrado
  !  O ambiente isolado de criação: não respondeu
  ?  A inteligência artificial: não foi possível perguntar

O Studio ainda não pode abrir. Falta isto: o pacote que dá a partida.
Sem ele o Studio não tem por onde começar, e o erro que aparece é uma mensagem
interna do Node.

Rode este comando:
  pnpm install --frozen-lockfile --filter '@dz23-studio/*...'
```

As quatro marcas querem dizer coisas diferentes:

| marca | o que quer dizer |
|---|---|
| `ok` | está no lugar |
| `>>>` | **o Studio não abre sem isso** — é o próximo comando a rodar |
| `!` | o Studio abre, e alguma coisa dentro dele não vai funcionar |
| `?` | não foi possível olhar — **não** quer dizer que está faltando |

Só aparece **um** `>>>` por vez. A ordem da lista é a ordem da causa, e não a da
gravidade: instalar o Studio antes do Harness não adianta, então o Harness vem
primeiro. Rode o comando que ele mandou, rode `pnpm studio:doctor` de novo, e
repita até não sobrar nenhum `>>>`.

## 3. Instalar

A sequência completa, se você preferir rodar tudo de uma vez em vez de seguir o
conferidor passo a passo:

```bash
pnpm --dir third_party/deepseek-harness install --frozen-lockfile
pnpm --dir third_party/deepseek-harness build:official
pnpm install --frozen-lockfile --filter '@dz23-studio/*...'
pnpm build
```

A ordem é obrigatória e o motivo é simples: os pacotes do Harness são
dependências do Studio, e o Studio lê os arquivos **já compilados** deles.

> O procedimento canônico completo, com os gates de verificação, está em
> [`BOOTSTRAP.md`](./BOOTSTRAP.md). Esta página é o caminho curto para abrir o
> produto; aquela é o caminho para provar a árvore inteira.

## 4. Abrir

```bash
pnpm studio
```

O comando confere tudo de novo antes de dar a partida — se faltar algo, ele
explica e não sobe. Quando sobe, o endereço **FRIGG — abra este endereço** aparece no terminal.
Ele aponta para `/studio/`, a interface do produto. Abra esse endereço no
navegador; a interface técnica do Harness não é aberta automaticamente. Para parar, `Ctrl+C`.

Tudo que o Studio guarda fica em `dsh-home/`, **dentro da pasta que você
baixou**. Nada é espalhado pelo seu sistema, e apagar a pasta apaga tudo.

## 5. Antes do primeiro aplicativo

Duas coisas não impedem o Studio de abrir, e impedem que ele **crie**. Você
resolve as duas depois de abrir, e a própria tela diz quais faltam:

**O ambiente isolado de criação (Docker).** Cada aplicativo é construído dentro
de um contêiner sem rede, com o sistema de arquivos somente leitura e nenhuma
permissão de sistema. Sem Docker rodando, o Studio planeja e não constrói. Abra
o Docker Desktop, ou instale o Docker.

**A inteligência artificial.** É ela que escreve o plano e o código. São três
rotas, e o conferidor diz **quais** estão configuradas pelo nome — e não quantas,
porque "duas configuradas" não conta a ninguém se o texto dele sai do
computador:

| rota | variável | o que ela é |
|---|---|---|
| **Ollama, no seu computador** | `DZ23_OLLAMA_BASE_URL` | Não manda o seu texto para fora. Precisa do Ollama rodando. É a primeira da lista de propósito. |
| **DeepSeek oficial** | `DEEPSEEK_API_KEY` | A rota padrão, e a única para a qual o Studio volta sozinho quando outra falha **antes** de escrever qualquer coisa. |
| **OmniRoute (externo, opcional, avançado)** | `DZ23_OMNIROUTE_KEY`, `DZ23_OMNIROUTE_BASE_URL` | **Desligada por padrão.** Só entra quando você configura a chave. |

Sobre o **OmniRoute**, o que vale é `ADR-014` e não preferência:

- ele é **externo e opcional**, e só passa a existir para o Studio quando você
  configura a chave — estar declarado no perfil não é estar configurado;
- o Studio consome dele **somente `/v1`**, um endpoint compatível com OpenAI;
- **`maxRetries: 0`**: quando há gateway, o gateway é a única autoridade de
  repetição e de troca de rota. Não existe repetição no meio do texto;
- ele **nunca fica ativo junto com o 9Router**, que não integra o perfil;
- só existe volta automática de OmniRoute para DeepSeek oficial quando a falha
  acontece **antes** de qualquer conteúdo visível. Depois disso o Studio não
  repete nem troca: ele devolve o erro, e o erro fica auditado;
- em modo `local-only`, só o Ollama saudável pode ser escolhido — se ele não
  estiver disponível o Studio **recusa**, e não cai silenciosamente para uma
  rota externa.

Nenhuma chave é escrita em arquivo gerado, log, pacote ou tela — só a referência
ao cofre. As variáveis acima são **nomes**, nunca valores no perfil.

## 6. O primeiro aplicativo

Escreva o que você precisa, em português, com as suas palavras. O Studio:

1. diz o que entendeu — **e diz quando não entendeu**, em vez de fingir;
2. faz as perguntas que faltam, uma por vez;
3. mostra o plano, que você aprova, edita, remove ou reordena — **nada é
   construído antes da sua aprovação**;
4. constrói, mostrando os quatro passos do construtor enquanto acontecem;
5. confere um a um os critérios que você aprovou — e o que **não** foi
   verificado aparece dizendo isso.

---

## Quando alguma coisa não funcionar

Rode `pnpm studio:doctor`. Ele responde uma pergunta por vez e sempre termina
num comando.

Se o conferidor disser que está tudo `ok` e mesmo assim algo não funcionar, isso
é um defeito do produto e não do seu computador — vale abrir uma *issue* com a
saída do `pnpm studio:doctor` colada inteira.

## O que ainda não está provado por aqui

Honestidade sobre o alcance desta página:

- o caminho de **instalação no Windows** por imagens OCI publicadas ainda não
  fecha (`D-10`) — quem quiser rodar hoje usa o caminho desta página, no WSL2
  com o clone em `ext4` (`~/...`, nunca `/mnt/c`);
- o conferidor foi provado contra estados reais de disco, incluindo o estado em
  que este repositório se encontrava quando ele foi escrito. A **partida
  completa** depende de o Harness estar instalado e compilado na sua máquina, e
  é o passo que cada ambiente precisa fazer por si.

## Quando um envio fica sem confirmacao

Ao editar o plano ou acrescentar uma etapa, uma falha de rede pode acontecer
quando o servidor ja guardou a mudanca. Confira o plano antes de tentar outra
coisa. No mesmo perfil de navegador, reenviar o mesmo pedido pendente recupera
a tentativa anterior, inclusive depois de fechar e reabrir a aba. O texto do
rascunho nao fica salvo: se fechar a aba, sera preciso redigita-lo.

Se o navegador nao conseguir preservar o envio, o FRIGG avisa e nao envia o
pedido. Verifique as permissoes de armazenamento deste site. Alterar o texto
inicia outra intencao; isso pode consumir modelo novamente. Sair da conta,
limpar os dados do site ou usar outro navegador/aparelho perde os recibos
locais. Essas garantias ainda nao se estendem aos demais tipos de envio.


Se uma resposta do questionario ficar sem resultado confirmado, o FRIGG nao
repete automaticamente a chamada do modelo. Confira a conversa antes de
escrever uma nova resposta: uma nova tentativa pode gerar novo consumo.
O mesmo cuidado vale para resposta digitada, que pode ser interpretada pelo modelo.


Se a resposta de criar uma tarefa se perder, voce pode reabrir no mesmo perfil
de navegador e repetir o mesmo pedido e opcoes para recuperar a tarefa.
O texto nao fica salvo no aparelho; e preciso preenche-lo novamente. Depois
da confirmacao, criar outro pedido igual inicia outra tarefa. Sair da conta,
limpar os dados do site ou voltar a uma interface antiga perde essa garantia.
