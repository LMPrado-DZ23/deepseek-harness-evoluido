# ADR-031 — Integration Hub v1: registro D16, SMTP por referência e pacote do protótipo (M5)

Status: aceita e implementada na etapa M5 (Claude). Numeração: a ADR-028 está
reservada à M1 (preview) do Codex.

## Contexto

O Plano Mestre v2 (D16, D17, cap. 4) pede um Integration Hub com integrações
declaradas por manifesto, tiers de aprovação T0–T3, segredos só por referência
e nenhum marketplace público antes de plugins assinados (ADR-009/ADR-013). A
pessoa leiga precisa de três coisas concretas nesta etapa: ligar o e-mail do
aplicativo gerado sem ver senha, saber se uma integração é confiável antes de
ligá-la, e levar o protótipo verificado consigo.

## Decisões

1. **Manifesto assinado, avaliação no servidor.** `plugins/integration-hub`
   avalia o manifesto (`schema_version: 1`, `id`, `name`, `version`, `kind`
   ∈ {`mcp`, `skill`, `webhook`}, `publisher`, `permissions`, `tier`,
   `endpoint?`, `signature?`) com chaves Ed25519 **públicas** dos publicadores
   (config `publisherKeys`, env `DZ23_HUB_PUBLISHER_KEYS`). A forma canônica
   assinada é o objeto **como enviado**, sem `signature`, sem defaults e sem
   `trim`, chaves em ordem de code point, JSON sem espaços, UTF-8 — cinco
   regras que qualquer biblioteca JSON reproduz. Resultado: `verified`,
   `unverified` (sem assinatura ou publicador sem chave) ou `invalid`
   (assinatura não confere → registro recusado e auditado).
2. **Tier efetivo = o mais restritivo (D16).** Piso por natureza:
   `secrets.read` nunca abaixo de **T3** (um segredo vazado não se desvaza);
   MCP externo, `network.outbound` e `email.send` nunca abaixo de **T2** (D16
   exige "nunca abaixo de T1" para MCP externo; T2 é mais restritivo e cumpre
   "conflito → mais restritivo"); MCP local, webhook e `write.project` nunca
   abaixo de T1; tier ausente ou inválido → T2. **Qualquer coisa abaixo
   de `verified` é limitada a pelo menos T2**, independentemente do que o
   manifesto declare. No canal `stable` (padrão), uma integração não
   verificada **não pode ser ligada** (403 e evento de recusa); o canal `dev`
   permite ligar uma **não assinada** para desenvolvimento local e a interface
   avisa isso em palavras — uma assinatura que **não confere** (`invalid`)
   nunca é ligada, em canal nenhum. O canal é lido **só da configuração do
   profile**: uma variável de ambiente não pode rebaixar a política de um
   Studio em execução (revisão do Codex na M5). `GET /integrations` devolve
   `channel`, `can_enable` e `requires_approval_tier` decididos pelo servidor:
   a interface nunca adivinha política.
2-B. **Os tiers são exigidos, não só exibidos (correção da M5).** Antes de
   ligar uma integração, configurar o e-mail do aplicativo ou disparar o teste
   de envio, o serviço exige o que o tier pede: **T0/T1** seguem e ficam
   registrados; **T2** exige uma confirmação da pessoa para **exatamente esse
   nível** (uma confirmação de outro nível não serve); **T3** exige a
   confirmação **e** uma passkey recente na mesma sessão (mesma janela do
   plugin de identidade), com falha fechada se não houver. Desligar nunca pede
   confirmação — reduzir exposição é sempre permitido. Cada confirmação aceita
   vira o evento `approval.recorded`; cada recusa vira um evento de falha. No
   painel, a confirmação é um passo visível com o que está sendo autorizado em
   palavras, e cancelar não envia nada ao servidor.
3. **SMTP do aplicativo gerado só por referência (D17).** A pessoa informa o
   **nome** do segredo no cofre (`^[A-Z][A-Z0-9_]{2,63}$`, ex.: `DZ23_APP_SMTP`);
   o Studio confere pelo seam `ctx.credentials` que ele existe e tem o formato
   `{host, port, secure, user, pass, from}`, e guarda **só o nome** na tabela
   `studio_integrations.integrations` (kind `smtp`, manifesto nulo, tier T2 por
   ser provedor externo). O kind `smtp` é reservado: um manifesto com esse
   kind é recusado. O teste de envio só existe quando o operador liga
   `DZ23_HUB_SMTP_TEST_ENABLED=1` depois de escolher o provedor (decisão do
   Prado em aberto); até lá responde `NOT_EXECUTED` com explicação. Erros do
   provedor nunca chegam crus à pessoa nem ao audit (só a classe do erro):
   mensagens de SMTP e de `JSON.parse` podem carregar trechos do segredo.
4. **Pacote do protótipo reproduzível e sem dados.** Só projeto em
   `VERIFIED_PROTOTYPE` com a última run `PASSED` cujos arquivos ainda existam
   **dentro da pasta de execuções** (`runsRoot`, o mesmo padrão do
   prompt-to-app): o caminho da run é resolvido por `realpath` e recusado se
   cair fora, se for link simbólico para fora ou se subir por `..`, **antes de
   qualquer leitura**. Ids e nomes de organização/espaço que viram caminho são
   validados como um único segmento (sem separador, sem `..`, sem controle).
   O ZIP (escritor/leitor próprio, sem dependência, timestamps fixos, bits
   Unix de tipo de arquivo) leva `app/**` do `.next/standalone`,
   `app/.next/static`, `app/public`, `evidence/appspec-report.json`, um
   `README.md` em linguagem comum e `.env.example` só com nomes. Ficam de fora:
   `data/` e caches **na raiz do app** (o `data/` de bibliotecas entra),
   `.env*`, `*.sqlite*`, `studio-capture.json`, `studio-auth-state.json`,
   `*.pem`, `*.key`, links simbólicos e `.git`. Além dessa lista de proibidos,
   vale uma **lista de permitidos por extensão**: um tipo de arquivo em que
   ninguém pensou fica de fora em vez de embarcar. Nada sai em silêncio — todo
   arquivo ou pasta que ficou de fora é listado **por nome** (nunca por
   conteúdo) em `EXCLUIDOS.txt` dentro do pacote. Sobre o que entra roda uma
   **varredura fail-closed**: bloco de chave privada, chave de provedor com
   prefixo próprio (AWS, GitHub, Slack, Stripe/OpenAI) ou string de conexão com
   senha **derrubam a exportação inteira** (`SECRET_DETECTED`, 409), dizendo
   qual arquivo. O limite honesto: arquivos binários não são varridos, e a
   varredura não promete achar todo segredo possível — ela fecha as formas que
   não têm falso positivo. Orçamento de 200 MB → recusa em palavras (413). Mesma run e mesmos bytes → o mesmo registro é devolvido, sem
   arquivo gêmeo. Arquivo em `~/.dz23-studio/exports/<org>/<tenant>/` com 0600;
   o caminho nunca sai pela API; download com `Content-Disposition` saneado e
   `x-dz23-sha256`.
5. **Fronteira HTTP igual à do Prompt-to-App.** `/api/studio/hub` exige host e
   origem permitidos, sessão do Studio, CSRF em toda escrita, membro do espaço
   (`authorizationFor`) e permissão por rota (`HUB_ROUTE_CONTRACTS`, conferido
   por `assertRouteContracts` na subida). Só erros conhecidos levam sua
   mensagem ao cliente; qualquer outro vira uma frase fixa (nada de caminho,
   `ENOENT`, `URIError` ou texto de biblioteca).
6. **Auditoria também das recusas, e minimizada.** Tabela
   `studio_integrations.events` (org + tenant + ator): registro,
   ligação/desligamento, SMTP configurado e testado (`not-executed` incluso),
   pacote gerado, confirmação registrada (`approval.recorded`) — e as recusas:
   manifesto inválido, assinatura adulterada, kind reservado, exportação
   negada, confirmação ausente ou de nível errado, passkey ausente. O
   histórico guarda **prova, não dados pessoais**: o destinatário do teste de
   e-mail entra como domínio + resumo `sha256` curto, nunca em texto claro.
   O nome do segredo é canonizado antes de tudo (`secret://NOME` e `NOME` são
   o mesmo nome; a caixa nunca é inventada).
7. **Painel próprio em `/studio/hub`.** `apps/studio-web/src/hub/*`, roteado
   por `main.tsx` sem tocar em `App.tsx` (o Codex edita esse arquivo na M1),
   catálogo `src/i18n/hub.pt-BR.json`. Quatro cartões: e-mail do aplicativo,
   integrações, baixar o protótipo, histórico. Sem rede, o 503 do service
   worker vira frase do catálogo.
8. **Sem marketplace.** Não há catálogo remoto, busca nem instalação a partir
   da internet: estado `NOT_PRESENT` até haver plugins assinados e decisão do
   Prado sobre publicação (ADR-009/ADR-013).

9. **Ferramenta do publicador.** `plugins/integration-hub/src/signing.ts`
   (`generatePublisherKeyPair`, `publicKeyFromPrivatePem`, `signManifest`) e o CLI
   `pnpm hub:sign keygen|pubkey|sign` produzem exatamente os bytes canônicos que o
   Studio verifica; a chave privada fica em arquivo 0600 (ou env) e nunca é
   impressa; assinar por cima de uma assinatura existente exige `--replace`.
   Guia: `docs/guides/integracoes-e-pacote-do-prototipo.md`.

## Correções da revisão adversarial das próprias correções (04/09, subagentes)

- **O nível exigido é o piso da natureza, não o que está gravado.** `setEnabled` e `testSmtp` usavam
  o `effective_tier` da linha; uma linha escrita com T0 (build antigo, migração, qualquer outro
  escritor da tabela) mandava e-mail de verdade **sem confirmação nenhuma** enquanto a tela seguia
  mostrando T2. Agora o tier exigido é o mais restritivo entre o gravado e o piso do kind, e
  `requiredApprovalTier` usa **a mesma expressão** da exigência — a tela não pode mostrar menos do
  que o servidor cobra.
- **Nada de atualização perdida.** `setEnabled` escrevia por cima o instantâneo lido antes da
  confirmação: uma re-registração concorrente que **subisse** o tier era desfeita em silêncio. Agora,
  se o registro mudou durante a confirmação, a ação é recusada (`CONFLICT`).
- **A varredura de segredos não desiste por tamanho.** Havia limite de 4 MB — "nenhum segredo
  encontrado" justamente nos arquivos onde um bundle esconde um. Agora a leitura é por fatias com
  sobreposição; e todo arquivo que a varredura **não sabe ler** (imagem, `.gz`, `.wasm`) entra no
  pacote com o nome listado em `EXCLUIDOS.txt` sob "entraram sem conferência", em vez de passar como
  se tivesse sido conferido.
- **A pasta `data/` do aplicativo não viaja em profundidade nenhuma** (antes só na raiz do
  standalone: um app uma pasta abaixo levava o próprio banco e os códigos capturados). Sob
  `node_modules` a regra não vale — ali `data/` é da dependência, e tirá-la quebraria o aplicativo.
- **Atalhos e nomes impossíveis também são nomeados.** Link simbólico sumia sem aparecer em lugar
  nenhum; nome com barra invertida virava erro 500. Agora os dois entram na lista de exclusões, com
  o motivo.
- **A raiz das execuções é obrigatória e não vem do ambiente.** Era opcional (serviço sem ela = sem
  confinamento) e o profile a lia de `DZ23_STUDIO_RUNS_ROOT` — três linhas abaixo do comentário que
  diz que variável de ambiente não pode mexer em política. Agora é obrigatória no serviço e escrita
  no profile.
- **Confirmação registrada só quando a ação aconteceu**, e as recusas de segredo ausente ou
  inválido passaram a ser auditadas: antes o histórico dizia "Confirmação da pessoa registrada" para
  uma configuração que não aconteceu, e a recusa não aparecia em lugar nenhum.
- **Honestidade do texto:** o passo de confirmação prometia que "o Studio vai pedir a sua passkey" —
  e o painel não executa cerimônia de passkey nenhuma. Agora diz o que de fato acontece: a ação só
  funciona se a passkey já tiver sido confirmada nesta sessão; senão o Studio recusa e nada muda.

**Correção posterior (mesmo dia):** a confirmação de T2/T3 deixou de ser afirmação do cliente. A
tela pede ao servidor uma aprovação para a ação exata (`POST /approvals`); o servidor decide o
nível, registra a decisão **antes** da ação, amarra a pessoa, a sessão, a ação e o alvo, expira em
três minutos e **gasta na primeira apresentação**. Uma aprovação inventada, reapresentada ou emitida
para outro alvo é recusada. Os tickets vivem em memória: um reinício os perde e a pessoa confirma de
novo — falha fechada; persistir exigiria versão nova do domínio.

E a janela TOCTOU da exportação foi fechada, não só reduzida: cada arquivo é aberto **uma vez**, com
`O_NOFOLLOW`, e tanto o tamanho quanto os bytes vêm desse mesmo descritor — `lstat` seguido de
`readFile` deixava um intervalo em que a entrada podia virar um link para outra coisa. Um link
plantado no lugar de um arquivo comum não é lido e aparece nomeado em `EXCLUIDOS.txt`; verificado
por mutação.

Limite anterior, agora histórico: a confirmação de **T2** era uma afirmação do cliente (um campo
JSON). O que separa isso de uma página hostil é CSRF + verificação de origem; **T3** é o único
nível com prova do lado do servidor (a passkey recente). Anotado para a fatia da arquitetura de
modos de confiança.


## Consequências

- Domínio novo `studio_integrations` (versão 1) roteado para Postgres nos dois
  patches; gates `domain-scopes` e `domain-routes` passam com 21 domínios.
- O gate de i18n passou a varrer de fato os plugins (havia um bug que pulava
  todos); 19 literais pré-existentes de outros plugins ficam contados como
  pendência que não pode crescer.
- Pendências fora desta etapa: provedor de e-mail (Prado), exportação de um
  standalone real produzido pelo pipeline (integração com M1/fatia 3),
  licença do repositório (P37 aponta ausência de `license` em todos os
  plugins — decisão do Prado).
