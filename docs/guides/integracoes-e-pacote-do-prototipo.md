# Integrações e pacote do protótipo — guia em linguagem comum (M5)

Este guia explica a tela **Integrações** (`/studio/hub`) do DZ23 STUDIO para quem usa o
Studio e, no fim, como um publicador assina uma integração. Nada aqui é "pronto para o
público": o Hub está em estado **BETA** (ver `docs/CAPABILITY_MATRIX.md`).

## Para quem usa o Studio

### E-mail do aplicativo

O aplicativo que o Studio cria envia códigos de acesso por e-mail. Para isso ele precisa de um
serviço de e-mail (SMTP). A senha desse serviço **nunca é digitada no Studio**: quem cuida do
servidor guarda a senha no cofre com um nome (por exemplo `DZ23_APP_SMTP`), e na tela você
informa **só esse nome**. O Studio confere que o nome existe e que o segredo tem o formato
certo (`host`, `port`, `secure`, `user`, `pass`, `from`) e guarda apenas o nome.

O botão **Enviar teste** só funciona depois que a pessoa responsável escolher o provedor de
e-mail e ligar `DZ23_HUB_SMTP_TEST_ENABLED=1` no servidor. Até lá a tela diz, em palavras, que o
teste **não foi executado** — e nada foi enviado.

### Integrações

Cada integração chega com um **manifesto**: quem publicou, o que ela faz e o que ela pede
para acessar. O Studio confere a **assinatura** do publicador com uma chave pública cadastrada
pelo responsável pelo servidor.

- **Assinatura reconhecida** → pode ser ligada.
- **Sem assinatura reconhecida** → o nível de confiança sobe para **T2** e, na versão estável,
  o botão "Ligar" fica desativado com a explicação ao lado. (No canal de desenvolvimento a tela
  avisa que isso é permitido só ali.)

Níveis de confiança (D16): **T0** só leitura local · **T1** escreve no seu espaço de trabalho ·
**T2** fala com serviços externos · **T3** acesso amplo. O nível efetivo é sempre o mais
restritivo entre o que o manifesto declara e o que a natureza da integração exige. Uma
integração que pede para **ler segredos do cofre** é sempre T3, mesmo que o manifesto diga
outra coisa.

**O que o nível muda na prática, na hora de ligar:**

- **T0 e T1** — liga direto, e fica registrado no histórico.
- **T2** — a tela pergunta antes, em uma frase, o que você está autorizando. Se você cancelar,
  **nada é enviado**. A mesma pergunta aparece ao guardar o nome do e-mail do aplicativo e ao
  disparar um teste de envio.
- **T3** — além da confirmação na tela, a ação só funciona se você **já tiver confirmado com a sua
  passkey nesta sessão**. O Studio não abre a janela da passkey aqui: se você entrou só com código
  por e-mail, a ação é recusada em palavras e a integração continua desligada. Isso não é um aviso
  que dá para passar por cima: é o servidor que recusa.

Desligar uma integração nunca pede confirmação — reduzir o que está ligado é sempre permitido.
Uma assinatura que **não confere** (adulterada, ou chave trocada) nunca é ligada, nem no canal
de desenvolvimento.

### Baixar o protótipo

Só um projeto **verificado** pode ser baixado. O pacote (`.zip`) traz o aplicativo, o relatório
da verificação, um `README` em linguagem comum e um `.env.example` só com **nomes** de
variáveis. Ficam de fora os seus dados (`data/`), arquivos `.env`, bancos SQLite, códigos
capturados e chaves. Além dessa lista, só entram tipos de arquivo conhecidos: um tipo em que
ninguém pensou fica de fora em vez de embarcar por acidente. **Nada fica de fora em segredo** —
quando alguma coisa fica de fora, o pacote traz um
`EXCLUIDOS.txt` com esses nomes (só os nomes; o conteúdo não sai do seu computador). Esse arquivo
só é criado quando há o que listar: **se ele não estiver no pacote, é porque nada ficou de fora e
nada entrou sem conferência** — não é sinal de que a lista falhou.

Antes de fechar o pacote, o Studio confere se algum arquivo tem cara de senha ou chave privada
(bloco de chave, chave de provedor, ou qualquer endereço que carregue usuário e senha — banco de
dados, servidor de e-mail, FTP, o que for). Se achar, **o pacote não é
gerado** e a tela diz qual arquivo — é melhor recusar do que entregar um segredo dentro de um
`.zip`. Arquivos binários opacos (imagem, fonte, WebAssembly, módulo nativo ou vídeo) não podem ser
conferidos por essa varredura e, por isso, **não entram** no pacote; aparecem em `EXCLUIDOS.txt`.
A conferência também não promete achar todo segredo possível: ela fecha as formas que dá para
reconhecer sem errar.

A tela mostra o **SHA-256** do pacote; o download traz o mesmo valor no cabeçalho
`x-dz23-sha256` para conferência. Pedir o pacote de novo para a mesma verificação devolve o
mesmo arquivo.

### Histórico

Tudo o que acontece nesta tela fica registrado com quem fez, quando e o resultado — inclusive
as recusas.

## Para quem publica uma integração

1. Gere um par de chaves **uma vez** e guarde a chave privada no seu cofre:

   ```bash
   pnpm hub:sign keygen ~/.dz23-studio/publisher-<seu-id>.pem
   # imprime a chave pública (SPKI base64) — é ela que o operador do Studio cadastra
   ```

2. Escreva o manifesto (`schema_version: 1`, `id`, `name`, `version`, `kind` ∈ `mcp`/`skill`/`webhook`,
   `publisher: { id, name }`, `permissions`, `tier`, `endpoint` quando houver) e assine:

   ```bash
   pnpm hub:sign sign manifesto.json ~/.dz23-studio/publisher-<seu-id>.pem --out manifesto.assinado.json
   ```

   A assinatura cobre o manifesto **exatamente como está no arquivo** (sem `signature`, chaves em
   ordem de code point, JSON sem espaços, UTF-8). Editou o manifesto? Assine de novo com `--replace`.

3. Envie ao operador do Studio a chave pública e o `publisher.id`. Ele registra em
   `DZ23_HUB_PUBLISHER_KEYS='{"<seu-id>":"<chave pública base64>"}'`.

4. Quem usa o Studio cola o manifesto assinado em **Registrar uma integração (avançado)**; a
   tela mostra "Assinatura reconhecida" e o nível de confiança antes de qualquer coisa ser ligada.

Não existe marketplace: cada integração entra pelo manifesto, com assinatura, e isso é
intencional até haver decisão sobre publicação (ADR-009/ADR-013/ADR-031).
