# PROJECT_STATUS — DZ23 DEEPSEEK ENGINEERING OS

> **Este é o arquivo de retomada.** Depois de qualquer interrupção — contexto
> compactado, sessão nova, máquina reiniciada — leia ESTE arquivo primeiro,
> depois `EXECUTION_JOURNAL.md`, depois `git status`. Não peça ao Prado para
> explicar o projeto de novo.
>
> No **Claude Code**, quem manda ler isto é o [`CLAUDE.md`](../../CLAUDE.md) da
> raiz, carregado sozinho em toda sessão. Ele tem a ordem de leitura, as regras
> que não se negociam e a disciplina de falsificação; os comandos estão em
> [`docs/OPERACAO.md`](../OPERACAO.md).

- `mission_id`: `ENGINEERING-OS-2026-09-11`
- `mission_intent`: evoluir o repositório para um Engineering OS sobre o DeepSeek Harness, preservando o motor e a compatibilidade com o upstream
- `state`: `EXECUTING`
- `branch`: `integ` (**não é `main`** — confirmar com `git branch --show-current`)
- `head`: ver `git log --oneline -1`; o último estado registrado aqui é `91c6aa0` + o trabalho desta iteração (T-27: revisão adversarial do portão de prévia)
- `harness_upstream_pin`: `6c705be1ce6774a000d061da41d1823b03a3d42c` (zero diff, `gate:upstream-pin` prova)
- `atualizado_em`: 2026-09-18

## RETOMADA EXATA — 18/09/2026

**Estado:** árvore limpa, `integ`, tudo entregue e enviado. Último commit
`5793623` (INT-01), CI acompanhada.

**A ordem em que as fatias saíram hoje**, todas com `CONFERE=SIM`:

| commit | fatia | CI |
| --- | --- | --- |
| `6932b55` | BR-F — a marca FRIGG, fonte única e `gate:marca` | cancelada pelo push seguinte |
| `29071fe` | EMP-CORR — colisão de rótulo com a matriz canônica, `gate:bus-matriz` | verde (cobre as duas) |
| `9ed8866` | EMP-04 — catálogo de ofertas (`BUS-03`) | verde |
| `5793623` | INT-01 — três idiomas, `gate:idiomas` | acompanhar |

**A CAPA do projeto foi atualizada em 18/09** (`BR-F09 / APO-01`): README, guias,
constituição, marcas e `CLAUDE.md` dizem FRIGG; as imagens do README passaram a
vir de `apps/studio-web/capturas/`, que o e2e produz; e o PIX de doação entrou
com portão próprio.

**A PORTA DE ENTRADA foi fechada em 18/09** (`BR-F10`), com a palavra do titular
("atualize tudo"). `scripts/capture-screenshots.mjs` foi **apagado** — ele
percorria o assistente de cinco telas e travava, e era uma segunda descrição da
jornada apodrecendo em ritmo próprio; as dez capturas velhas de `docs/images/`
foram junto, porque nada as referenciava desde que o README passou a ler
`apps/studio-web/capturas/`. A **descrição** e os **tópicos** do repositório no
GitHub foram atualizados e conferidos de volta (`gh repo view`).

**Duas superfícies do GitHub foram corrigidas em seguida** (`BR-F11`): o nome
do fluxo de CI ainda dizia `Verify DZ23 STUDIO` — apareceu na saída de
`gh run list`, enquanto eu conferia a CI da fatia anterior — e o `.github/FUNDING.yml`
negava pedir dinheiro citando uma cláusula que a ADR-054 já tinha substituído.
`gate:marca` passou a olhar o valor de cada `name:` do fluxo.

**O que continua fora do repositório:** a **imagem social**. O arquivo existe e
tem portão (`docs/images/social-card.png`, gerado por
`scripts/build-social-card.mjs`), mas o GitHub não a expõe na API REST nem no
`gh` — ela é enviada à mão em *Settings → General → Social preview*. O arquivo
está provado; o efeito, não.

**A REVISÃO EXTERNA de `a04b0d6` foi respondida em 18/09** (`REV-A04`,
identificador `FRIGG-REVISAO-A04B0D6-20260918-R1`). Os quatro achados foram
revalidados no HEAD antes de qualquer conserto, e os quatro persistiam:

| achado | o que era | onde está agora |
| --- | --- | --- |
| R-A04-01 | `nomeAcessivelDaMarca()` devolvia português fixo, e o trilho o usava no `aria-label` em qualquer idioma | a ação vem de `rail.marcaAcao` nos três catálogos, com `{marca}` interpolado; teste de tela nos três idiomas e asserção no e2e |
| R-A04-02 | a tabela dizia `BUS-03` PARCIAL e a conclusão, doze linhas abaixo, dizia AUSENTE | conclusão corrigida por significado, ausência antiga preservada como citação histórica datada, e `gate:bus-matriz` passou a conferir uma contra a outra |
| R-A04-03 | a retomada chamava `bash /tmp/gates.sh`, um programa fora do repositório | `pnpm gates` (`scripts/run-gates.mjs`), que descobre a raiz e a lista de portões sozinho; `gate:portability` confere o bloco de retomada |
| R-A04-04 | `idiomaEfetivo` comparava relógios de máquinas diferentes | precedência sem relógio: a troca desta sessão vence tudo, e entre as guardadas vence a de maior `versao` |

**O que o conserto encontrou, e a revisão não podia ver.** Ao medir a família do
primeiro achado em vez do caso, apareceram mais dois irmãos calados nas mesmas
Preferências: dois formatadores de número fixos em `pt-BR`. E o agregador
versionado revelou que a lista escrita à mão em `/tmp/gates.sh` tinha **trinta**
nomes enquanto o `package.json` tinha **trinta e um** — `gate:licenses:release`
nunca rodou localmente em sessão nenhuma.

**A CI de `BR-F11` reprovou, e a causa não era a fatia** (`CI-08`).
`scripts/studio-start.spec.mjs` — um teste que só confere caminhos de arquivo —
esperava por `docker info`, que tem dez segundos de espera dentro de um caso com
cinco. Reprovação garantida sempre que o Docker demorar, escrita no código.
Reproduzi a falha antes de consertar, e o conserto foi tirar o mundo de dentro
do teste, e não aumentar o limite dele.

**O GARGALO REAL foi encontrado em 18/09** (`MOD-01`), e não era nenhuma das
duas coisas que o titular perguntou. Ele perguntou por anexo e por construir
jogos; a medição foi atrás do que impedia QUALQUER aplicativo de ser gerado por
modelo real, e achou:

- os quatro sítios que leem saída de modelo — geração, plano (duas vezes) e
  AppSpec — faziam **`JSON.parse` cru**;
- o `qwen2.5:3b` na máquina do titular devolve o JSON **dentro de cerca
  markdown**, e o JSON lá dentro é válido e bate com o schema campo por campo;
- logo, toda tentativa de geração morria antes de começar, e as três tentativas
  morriam igual, porque a causa não era aleatória.

Isso atravessou a missão inteira porque **o dublê sempre responde no formato
exato**. Segunda amostra, minutos depois: o MESMO modelo respondeu **sem** cerca.
Não existe prompt que garanta a forma — a tolerância tem de estar no leitor.

**E a GPU derrubou o número que sustentava `EB-04`.** A medição de 12/09 foi em
CPU. Hoje, na mesma máquina, o Ollama carrega o modelo **100% na GPU** (GTX 1650,
4 GB) e o prompt de 2.306 caracteres completa em **11 s** — o prompt real de
geração, em **4,8 s**. Os "45–50 s" eram da máquina sem GPU, e não do modelo.

**A JORNADA REAL foi rodada em 18/09** (`MOD-02`), com o Ollama do titular e o
prompt do produto. Ela não completou — e o caminho até onde ela parou rendeu
três defeitos, todos da mesma família: **a rodada de reparo foi escrita como se
o modelo lembrasse do prompt anterior, e ele não lembra.**

1. O reparo não dizia "produza somente JSON" → o modelo respondeu em **YAML**.
2. O reparo não levava o schema → o modelo recebia "expected string, received
   object" sem ter como saber que o conserto era o `kind` da entidade.
3. Tirar o schema da montagem **não quebrava nada**: `t()` devolve `{schema}`
   visível quando o valor falta — decisão certa para mensagem de erro que uma
   pessoa lê, errada para prompt, que só o modelo lê. Nasceu `prompt()`.

**Onde ela parou, e isto é o próximo gargalo.** O modelo descreveu um jogo da
velha e teve de encaixá-lo em `landing-page`, com entidades que só podem ser
`static-content` ou `database`. Um tabuleiro não é nenhum dos dois. Ele marcou
`static-content` e deu campos estruturados — a resposta mais razoável possível
para uma ontologia que não prevê o caso. **A ontologia do produto é a cerca**, e
o titular autorizou derrubá-la.

**O pacote `FRIGG-EXECUCAO-ADAPTADA-20260918-R1` foi incorporado em 18/09**, uma
vez, sem novo MASTER. Ele traz 370 seções editoriais — não são 370 tarefas — e
DUAS ressalvas delimitadas (item 57). As duas persistiam, e as duas foram
reproduzidas antes do conserto (`REV-ADAPT-A/B`):

- **A.** `pnpm gates` **não rodava no Windows**: `spawnSync('pnpm.cmd', …)`
  devolve `EINVAL` no Node 24. Reproduzido na máquina do titular. O agregador
  deixou de usar gerenciador de pacotes — lê o comando no `package.json` e roda
  `node`/`tsx` com `process.execPath`, sem shell, e recusa em voz alta o que
  estiver fora desse subconjunto. Provado no Windows dele.
- **B.** o teste da sonda padrão provava a **constante**, não o **consumo**. A
  propriedade certa é comportamental, e quem a controla é o `PATH`.

**`ONT-01` COMEÇOU em 18/09 e NÃO está concluída** (`ONT-01a`). A especificação
deixou de ser cerca: existe `app-state` — o estado que muda enquanto a pessoa
usa e não é banco — e existe a categoria `outro`, com sinais, atalho na home e
casos de compreensão próprios. A resposta literal que a jornada de hoje recusou
passa a valer mudando só o discriminante.

**Mas a revisão do titular estava certa: a especificação é a primeira camada.**
MEDIDO agora: `assertGeneratedSource` recusa `useState`, `onClick` e qualquer
chamada de função. O tabuleiro que o schema aceita **continua sem poder ser
escrito**. A política declarativa é deliberada e protege de verdade — o trabalho
é um perfil interativo em ambiente isolado, sem afrouxá-la para o perfil que já
funciona. Ele atravessa planejamento, geração, perfil, isolamento e prévia.

**Dois defeitos meus, do mesmo dia, consertados aqui:** o `prompt()` procurava
marcador DEPOIS de interpolar — quem escrevesse "rota `/clientes/{id}`" derrubava
o intake —, e o leitor de resposta escolhia em silêncio entre dois blocos, tendo
escolhido o EXEMPLO num dos casos.

**A próxima fatia, e por que ela é grande.** A cobertura trilíngue é de
navegação + Preferências. O passo seguinte é migrar as demais superfícies, e a
medição de hoje diz o tamanho: `pt-BR.json` tem **398 chaves**, `hub` tem 138,
`empresa` 113, `assistant` 111, `tarefa` 75, `team` 72, `mission` 64, `destinos`
56, `pwa` 19, `home` 14, `categorySignals` 8, `help` 13 — mais os **19
catálogos dos plugins**.

Nenhuma superfície é independente das duas maiores: a home e a conversa vivem
em `pt-BR.json`, e as quatro telas do trilho dependem de `hub`. Migrar meia
delas produz exatamente a tela meio traduzida que o adendo e este repositório
proíbem — pela mesma razão que o tema claro está parado.

**Por onde continuar, em ordem:**

1. `pt-BR.json` (398) — desbloqueia home e conversa, que são o produto;
2. `hub` (138) + `destinos` (56) — desbloqueia as quatro telas do trilho;
3. `empresa` (113) e `assistant` (111);
4. o resto, e os catálogos dos plugins.

Cada uma fecha registrando o espaço de nomes em `ESPACOS_TRADUZIDOS`, o que faz
`gate:idiomas` passar a cobrá-lo — e atualiza a frase `idiomaCobertura` nas três
línguas, que é onde a pessoa lê o que está e o que não está traduzido.

**Comando de retomada:**

```
git log --oneline -1 && git status --short && git branch --show-current
pnpm gates
```

`pnpm gates` roda **todos** os portões que o `package.json` declara — a lista é
descoberta, e não transcrita — e termina executando a constituição sobre os
vereditos que acabou de coletar. Ele acha a raiz do repositório sozinho, então
funciona de qualquer diretório e em qualquer máquina; os vereditos e os registros
de cada portão vão para o temporário do sistema, e o caminho sai impresso na
última linha. `pnpm gates --listar` diz o que ele rodaria sem rodar nada.

Isto substituiu um `/tmp/gates.sh` escrito à mão, que sumia a cada reinício e
trazia a lista de portões copiada — ela estava um portão atrás do
`package.json`. `gate:portability` passou a conferir este bloco.

**O que NÃO está autorizado, e continua não estando:** contratar, cobrar, mudar
DNS, criar aplicativo OAuth em conta externa, publicar, migrar produção,
`force-push` e merge em `main`.

## O que este repositório É hoje

**Um Prompt-to-App Studio**, não um Engineering OS. Essa é a distância a
percorrer, e nomeá-la é o começo honesto: o produto atual recebe o pedido de
uma pessoa leiga e gera **um aplicativo**. A missão pede um sistema que receba
um repositório e conduza engenharia sobre ele.

Muita coisa do Engineering OS **já existe** e não deve ser reimplementada —
ver `docs/audit/ENGINEERING_OS_CAPABILITY_MATRIX.md`, que mede capacidade por
capacidade com citação de arquivo.

## Baseline medido em 2026-09-11

Todos reproduzíveis pelo comando ao lado.

| verificação | resultado | comando |
| --- | --- | --- |
| typecheck | PASS | `pnpm typecheck` |
| build | PASS | `pnpm build` |
| suíte raiz | 3978 testes, 227 arquivos, 0 falha (18/09, após BR-F) | `pnpm -w test` |
| suíte studio-web | 800 testes (18/09, após BR-F) | `cd apps/studio-web && npx vitest run` |
| e2e navegador | 158 aprovados, 0 reprovados, 3 pulados (17/09, quatro tamanhos) | `cd apps/studio-web && npx playwright test` |
| PostgreSQL real | **65 testes, `POSTGRES_GATE=PASS`** (12/09, PostgreSQL 16.13 local) | `pnpm test:postgres` |
| portões | **26/26 PASS** | ver abaixo |

Portões, todos `EXIT=0` em 12/09/2026: `domain-scopes`, `domain-routes`,
`assistant-tools`, `team-role-tools`, `rls-coverage` (8/27), `upstream-pin`,
`portability`, `i18n` (26 catálogos, 641 chaves), `comprehension`, `vocabulary` (26 catálogos), `memory-map` (7 memórias, 0 ausentes), `constitution` (14 cláusulas),
`tracked-lib`, `image-lock`, `decision-record` (52 decisões), `requirements-ledger` (235 requisitos),
`secrets` (5.735 arquivos), `no-caveman`, `p37` (12/12),
`vendored-references` (3/3), `licenses` (848 pacotes), `licenses:release`.

## Como abrir o produto

`pnpm studio:doctor` confere o ambiente e devolve **um** comando por vez.
`pnpm studio` dá a partida. A página de uma folha é `docs/COMECAR.md`.

Isto não existia até a OS-77, e a ausência era o defeito mais grave da missão:
quarenta scripts `prove:*`, nenhum `start`, e a primeira execução respondendo
com oito linhas de pilha do Node — exatamente o que o README diz que este
produto existe para não fazer.

## Trabalho desta iteração

1. Remoção de `hasApprovedAncestor` — autorização por linhagem SEM conferir o
   worktree, exportada ao lado da versão correta. Ninguém chamava; o risco era
   o próximo leitor escolher pelo nome mais curto.
2. Remoção de `startDelegation` — porta de entrada pública sem chamador e sem
   teste.
3. Botão "Voltar para este ponto" deixou de aparecer quando voltar é
   impossível. Tabela exaustiva `UNDO_AVAILABLE_BY_STATE` espelha
   `UNDO_TRANSITIONS` do servidor.
4. `CATEGORY_NOT_IMPLEMENTED` saiu do union (nunca era lançado) e as duas
   listas negadas de categoria viraram `CATEGORY_REQUIRES_DATA_MODEL`,
   exaustiva.
5. Os dois `catch {}` do gerador de e-mail — que viajavam para dentro de todo
   aplicativo gerado com formulário — passaram a distinguir arquivo ausente de
   arquivo corrompido.

6. **OS-77 — o produto ganhou porta de entrada.** `pnpm studio` e
   `pnpm studio:doctor`, o doctor puro em `scripts/studio-doctor.mjs`, o
   `.nvmrc` que faltava e `docs/COMECAR.md`. 31 falsificações, todas pegas. A
   partida completa **não** é provada daqui: este contêiner está ele mesmo no
   estado "pacote de arranque não encontrado".

7. **OS-78 — vazamento do texto da habilidade, e o OmniRoute na primeira
   execução.** A listagem devolvia `skill_body` a qualquer `workspace.read`,
   desligada inclusive; agora há uma `publicIntegration` única nas três rotas.
   E as três rotas do perfil (ADR-014) entraram no doctor, com os limites do
   OmniRoute presos por teste. 18 falsificações, todas pegas.

8. **OS-79 — T-10 e T-20 fechados.** As regras do construtor chegaram ao
   PLANEJADOR (um plano não pode mais prometer o que o construtor vai
   recusar), e o Learning Engine falou com alguém pela primeira vez: quando
   uma criação falha, a pessoa lê se aquela falha já foi superada antes — com
   os dois números junto. 13 falsificações, todas pegas; uma delas pegou um
   **comentário meu que mentia** sobre por que a ordem das linhas importava.

9. **OS-80 — T-11 fechado.** A rota do texto de habilidade existia desde a
   OS-76 e **nenhuma tela a chamava**. Agora há tela, e ela confere o tamanho
   enquanto a pessoa cola — o servidor exige o número exato de caracteres, e
   descobrir isso por tentativa e erro numa recusa de servidor é o oposto do
   que este produto promete. 11 falsificações, todas pegas.

10. **OS-81 — T-22 fechado.** A varredura das execuções era **quadrática**:
    `runs(projectId)` lê o repositório inteiro, e o laço sobre os projetos
    fazia isso uma vez por projeto — **188 ms** com quinhentos projetos, num
    endereço que a tela consulta. Virou uma leitura só (10,6 ms). E a sondagem
    de armazenamento passou a perguntar a dois domínios, dizendo qual falhou.

11. **OS-82 — T-15 fechado, e o primeiro modelo REAL.** Os apelidos de
    caminho (`@/src/...`) viraram aresta de verdade — era assim que o template
    gerado importa quase tudo, e o grafo ignorava. E o `qwen2.5:3b` do Ollama
    do Prado gerou código que **passou nas guardas do Studio**: primeira vez
    que uma guarda foi exercitada por texto de modelo, e não por texto meu.
    O prompt real, porém, não completa em 45 s naquela máquina — está em EB-04.

12. **OS-83 — pacote V6, fatia E0 (EVO-01).** Os quinze candidatos do pacote
    foram **decididos antes de qualquer instalação**: 15 decididos, **zero
    instalados, zero capacidades perdidas**. O risco que a AT-114 cobra não é
    adotar demais — é a capacidade sumir junto com o candidato recusado, e por
    isso todo candidato nomeia a autoridade que já a possui. 
    é o 22º portão. 14 falsificações, todas pegas.

13. **OS-84 — pacote V6, fatia E1 (EVO-02/03).** A marca da empresa aplicada em
    **dois formatos** a partir da mesma `DesignSpecV1`, e um leitor de pacote de
    marca que **não executa nada**. Quatro achados, e o portão de i18n expôs um
    defeito de desenho: o marcador dentro do artefato estava em português, e
    teria quebrado a conferência de travessia no dia da tradução.

14. **OS-85 — pacote V6, fatia E2 (EVO-06/07/08).** Perfis por capacidade **sem
    queda para o host**, alvos com as cinco etapas separadas, e atestação que
    compara por igualdade em vez de "compatível". 14 falsificações, todas pegas.

15. **OS-86 — pacote V6, fatia E3 (EVO-04/05/09/10/11).** Mapa de origem com
    **três** estados (parcial recusa editar), as quatro qualificações que **não
    se promovem**, handoff que não amplia escopo, e rollback que não promete
    desfazer cobrança. 16 falsificações, todas pegas.

16. **OS-87 — pacote V6, fatia E4 (EVO-12).** Retirada de componente sem perder
    ativo, sem exportar segredo e **sem fingir que cancelou contrato externo**;
    e ganho medido, com `NAO_MEDIDO` como resultado de primeira classe.
    **As cinco fatias E0–E4 do pacote V6 estão entregues.**
17. **OS-88 — revisão adversarial de `staging` e `integration-hub` (T-29).** Os
    dois plugins menos olhados da missão estavam em **0/12**, e a superfície
    menos olhada é onde mora o próximo achado. Duas revisões independentes
    leram os dois por inteiro e trouxeram **onze achados ancorados em arquivo e
    linha**; os três piores tinham **teste passando ao lado**, e um deles tinha
    o defeito escrito na própria asserção. Todos corrigidos com teste próprio.
    - **SSRF (crítico).** A decisão sobre o destino de uma integração morava
      numa lista de expressões regulares comparada com o TEXTO do host — e o
      texto de um endereço não é único. `http://[::ffff:169.254.169.254]/` (o
      serviço de metadados de nuvem, que entrega credencial da máquina para
      quem perguntar) chega ao `URL` do Node como `::ffff:a9fe:a9fe`;
      `metadata.google.internal.`, com o ponto final do nome absoluto, resolve
      igual e não casa com `\.internal$`; e `100.64.0.0/10` não estava em lista
      nenhuma. A correção não foi mais uma regex: `host.ts` **normaliza** o host
      e decide por **faixa numérica**, então uma forma nova de escrever o mesmo
      endereço cai na mesma decisão em vez de precisar de mais uma linha.
    - **Autoridade dividida na assinatura.** Um manifesto v1 legítimo que
      omitisse `permissions` era gravado como `verified` e reprovado como
      `invalid` em toda reconferência — porque o `.default([])` do schema
      injetava um campo que o publicador nunca escreveu, uma linha abaixo do
      comentário que ensina exatamente isso sobre o `.trim()`.
    - **Quarentena global por falha SEM efeito.** No staging, `artifacts.open`
      era a única chamada fora de um `try`; ela lança para condições
      definitivamente sem efeito, e a exceção virava "efeito desconhecido". Como
      o destino físico é um só para a instalação inteira e a saída da quarentena
      exige um recibo que nunca existiria, um manifesto torto de um projeto
      parava o staging de todo mundo. **Prova de ausência não pode virar
      ausência de prova.**

18. **OS-89 — Visual QA em três tamanhos de tela (T-18).** A OS-73 declarou o
    que faltava: só a tela inicial, e sem comparar entre tamanhos. A metade que
    uma foto consegue fechar é a que mais dói — o defeito que este produto de
    fato produz não é a página branca no computador de quem programou, é a que
    abre no **celular** de quem não programa e não mostra nada. A suíte gerada
    fotografa em três larguras, **um tamanho vazio reprova mesmo com os outros
    dois desenhados**, e o que não pôde ser olhado sai nomeado em vez de sumir.
    O leitor confere a **largura da imagem contra o nome do arquivo**: uma
    captura de celular com a largura do computador é o tamanho que nunca foi
    aplicado, e ela aprovaria o celular descrevendo outra coisa.

19. **OS-90 — revisão adversarial de identidade e sessão (T-29).** Sete achados,
    e o pior deles **desfazia um conserto anterior**. A OS-33 igualou o corpo e
    o relógio de `/magic/start`; o pedido **seguinte** respondia a mesma
    pergunta — "essa pessoa tem conta aqui?" — com um status HTTP, porque quem
    não tem conta não ganha registro de código e recebia 404 onde quem tem
    recebia 401. O teto de tentativas era por registro, e um teto por registro
    não é um teto de conta: cada reenvio nascia zerado, e quem não tem registro
    **nunca travava**, o que separava os dois casos de novo. Agora o teto é por
    e-mail e é conferido **antes** de olhar o registro.
    - O mesmo oráculo existia na chave de acesso: os identificadores-isca
      disfarçavam `/passkey/login/options`, e a rota irmã desfazia o disfarce
      com 404 contra 500.
    - `assertRequestTrust` — a única conferência de `Host`/`Origin` das mutações
      autenticadas de **todos** os plugins — falhava **aberta**. O critério já
      estava escrito dez linhas acima, sobre os cookies: um serviço montado sem
      declarar a configuração cai no lado seguro.
    - No aplicativo gerado, fechou o quinto achado aberto da OS-20: banco
      travado virava **"faça login de novo" para sempre**.

20. **OS-91 — LOGIN CSRF no aplicativo gerado (T-29).** Fecha o quarto e o
    terceiro achados que a OS-20 deixou abertos. As ações de login não tinham
    token próprio e dependiam só da conferência de Origin do Next — a mesma
    propriedade de navegador em que o plugin de identidade do Studio se recusa a
    confiar sozinho. O ataque é pior do que parece: a página de um atacante faz
    o navegador da vítima **entrar na conta dele**, e daí em diante tudo que ela
    escrever fica guardado onde ele lê. E a pasta da captura de prévia nascia
    com a máscara do processo, listável por qualquer um — o arquivo já era
    `0o640` de propósito, a pasta é que faltava.
    **Sobra um achado aberto da OS-20**, e ele foi aceito: o painel de
    indicadores mostra agregados a qualquer sessão, pela mesma razão de o painel
    CRUD ser compartilhado.

21. **OS-92 — `gate:lib-freshness` (lacuna declarada no `CLAUDE.md`).**
    `gate:tracked-lib` confere se o `lib/` versionado está **completo**, e nunca
    conferiu se ele corresponde ao `src/`. É a forma mais silenciosa de segunda
    verdade que este repositório já produziu: certo no lugar que todo mundo lê,
    errado no lugar que de fato executa — `tenancy/lib/` ficou vinte e tantos
    commits atrás com uma correção de **autorização** parada dentro. O portão
    novo compila e compara byte a byte, e **achou um defeito na primeira
    execução, contra o meu próprio trabalho**: as correções de segurança da
    OS-90 não estavam no artefato versionado da identidade.

22. **OS-93 — o teto em dinheiro (T-19).** O que estava parado era o **número**,
    não o mecanismo. A tabela de preço é decisão do Prado; o motor que a usa não
    é, e ele foi construído para o estado de hoje — tabela **vazia**. Modelo sem
    preço nunca vale zero, preço tem validade obrigatória, e `SEM_TABELA` é um
    desfecho próprio em vez de "sem limite": um campo não preenchido não pode
    virar autorização de gasto ilimitado.
    **O que falta aqui não é engenharia** — é o Prado preencher a tabela e
    decidir se `NAO_MEDIDO` bloqueia ou apenas avisa.

23. **OS-94 — a porta de saída da pesquisa (T-17).** Mesmo padrão da OS-93: o
    que estava parado era a **autorização**, não o mecanismo. A porta existe e
    está **fechada** — lista vazia recusa, só `https:`, cada redirecionamento
    passa pela mesma porta, e não há valor padrão que autorize. Nenhuma saída
    existe: não há cliente HTTP nem busca, e nenhum teste toca a rede.
    `host.ts` mudou de `integration-hub` para `policy`, porque `prompt-to-app`
    precisa dele e não pode depender do hub — duplicar a normalização seria
    segunda verdade na guarda de SSRF, que é onde ela custa mais caro.

24. **OS-95 — o teto em dinheiro ligado à missão (T-19).** A OS-93 declarou o
    que faltava para ligar, e isso era engenharia: `MissionRunUsage` não
    carregava provedor, modelo nem a separação entrada/saída — e os dois preços
    são diferentes, em geral por um fator de cinco. O `gasto` agora sai
    **sempre** na resposta, inclusive hoje, como `SEM_TABELA`: esconder o campo
    enquanto a tabela não existir deixaria a **ausência invisível**, e quem abre
    o painel veria um total zerado que pareceria medido.
    O teto em dinheiro é **mostrado, e ainda não aperta** — impor exige decidir
    o que acontece quando o veredito é `NAO_MEDIDO` no meio de uma execução.

25. **OS-96 — `gate:typecheck`, e as quatro suítes rodadas de verdade.** Achado
    **contra a minha própria disciplina**. O `CLAUDE.md` já mandava rodar o
    `tsc` nos dois projetos, e a regra estava certa; o que falhou foi a
    execução — numa sessão de nove entregas o segundo foi rodado uma vez, no
    começo, e a OS-95 quebrou o dublê de e2e sem que a suíte da raiz, os 23
    portões nem o `tsc` da raiz acusassem. Só apareceu quando o Playwright não
    subiu. **Um passo manual que dá para pular é um passo que vai ser pulado.**
    Nesta entrega as quatro suítes rodaram: raiz 3.749, studio-web 527, **e2e
    117 em quatro tamanhos**, **PostgreSQL 16 real 65/65**.

26. **OS-97 — a borda muda deixa de ser silenciosa (T-32).** Um dos dois
    achados que a T-32 tinha em aberto, e o motivo registrado era bom: fechar
    exigiria **recusar** o pedido, o que troca o contrato de `edgeRequired`, e
    isso é decisão do Prado. Mas havia um terceiro caminho que não toca o
    contrato — tornar a falha **visível**. Com borda obrigatória e sem
    `X-Forwarded-For`, todos os clientes caem no mesmo balde e um visitante
    qualquer tranca todo mundo para fora sem fazer nada de errado. Não é brecha;
    é indisponibilidade por configuração, e o que esta casa não aceita é que
    seja silenciosa.
    E o `gate:lib-freshness`, de **um dia de idade**, pegou o artefato de
    identidade desatualizado outra vez.

27. **OS-98 — a interface principal virou o WORKSPACE da referência (ADR-050).**
    Esta é a entrega que corrige a falha mais cara desta missão, e ela é minha:
    o pacote V6 trazia **duas imagens de referência e uma especificação
    visual**, e nove entregas seguidas não mudaram um pixel. O Prado perguntou
    duas vezes por que o sistema não tinha mudado. A resposta honesta era que o
    trabalho visual nunca tinha sido feito.
    O que mudou agora é **estrutura**, e não pintura: a casca virou uma só
    (`WorkspaceShell`) em toda tela; a home virou título centrado, compositor
    amplo e atalhos; e a jornada de cinco etapas deixou de ser a home
    obrigatória e virou painel de contexto **dentro** da tarefa. Tipo, aparência
    e privacidade continuam inteiros, com os mesmos controles e as mesmas
    frases, em "Ajustes desta tarefa" — nenhuma função sumiu por ter mudado de
    lugar. A marca é o **PNG do proprietário**, cortado na margem externa e
    reduzido: sem remoção de fundo, sem revetorização, sem filtro de inversão.
    A migração encontrou **três defeitos reais** que só existiam porque o tema
    claro era o padrão: as telas de objetivos e de equipe nunca tiveram bloco
    escuro (o axe mediu 2,85:1 no vermelho delas); a gaveta fechada só era
    deslocada para fora da tela, continuando no foco do teclado e na árvore do
    leitor de tela; e o cabeçalho ficava fora de qualquer marco.
    `Navigation.spec.tsx` foi **substituído** por `shell/Rail.spec.tsx`, que
    carrega a tabela ligando cada comportamento coberto antes ao teste que o
    cobre agora. As quatro suítes rodaram: raiz **3.751**, studio-web **525**,
    **e2e 119 em quatro tamanhos** (era 117), **PostgreSQL 16 real 65/65**, 24
    portões `EXIT=0`, e **10 capturas reais** do produto em `docs/images`.

28. **Conferência do MASTER V6, e o que ela encontrou.** O Prado pediu para
    conferir se a execução cobriu o MASTER inteiro ou só parte dele. A resposta
    medida está em `audit/V6_CONFERENCIA_2026-09-16/`: dos **110 requisitos** da
    matriz V6, **25 IMPLEMENTADA, 52 PARCIAL, 32 AUSENTE e 1 AUSENTE_EM_RUNTIME**.
    O achado que governa: antes desta conferência **apenas 12 dos 110 IDs**
    (`EVO-01`…`EVO-12`) apareciam em algum lugar deste repositório — não havia
    rastreabilidade entre a matriz do MASTER e este código, e por isso ninguém
    podia dizer quanto estava coberto.
    Três fatos que precisam ficar escritos: (1) o **Modo Empresa não existe** —
    22 dos 24 `BUS` são AUSENTE, e os dois PARCIAL são mecanismos genéricos que
    não são de negócio; (2) das 12 entregas `EVO` registradas como feitas,
    **onze não têm chamador de produção** — são funções puras com suíte, dentro
    de um plugin que não as exporta nem as importa; (3) a **parada de emergência
    não existia em execução** (ver OS-99).

29. **OS-99 — a parada de emergência passa a existir em execução.** O plugin
    estava completo e não era montado em perfil nenhum. O conserto é uma linha
    no perfil; a guarda é `gate:profile-mounts`, que reprova qualquer dependência
    `@dz23-studio/*` declarada e não montada. No mesmo passo saiu um bloco
    `builder:` do perfil com três chaves que não existem na configuração real —
    configuração que parecia ter efeito e não tinha.
    Limitação declarada: a montagem é provada pelo **portão**, não por subir o
    runtime — este ambiente não tem Docker e nenhum teste inicializa o perfil
    Cordis real.

30. **Reconciliação com o pacote COERENTE, e OS-100 (UX-02).** O Prado apontou
    que existem **dois pacotes chamados V6** com definições diferentes para os
    mesmos IDs, e fixou o `COERENTE` como referência. Os três hashes conferem.
    A comparação mostrou o tamanho real da divergência: as **98 obrigações
    não-EVO são idênticas** nos dois pacotes, texto por texto — para essas o
    veredito segue valendo, não por igualdade de ID, mas porque a obrigação é a
    mesma. Os **12 EVO colidem**: mesmo ID, obrigação diferente, e foram
    reavaliados contra o aceite do pacote novo, com a origem da evidência
    registrada. Quatro (`EVO-13`…`EVO-16`) são novos.
    A matriz passou a separar **três dimensões**: implementação (24/54/36),
    integração (58 ligadas ao perfil, 11 **sem chamador**, 9 fora do runtime) e
    tipo de prova. **Nenhum requisito tem prova de tipo `RUNTIME_CORDIS` ou
    `PROVIDER_REAL`** — essa linha está inteira em aberto.
    `OS-100` fechou a primeira lacuna autorizada: uma intenção de envio cria
    **uma** tarefa. Reserva durável gravada antes da tarefa, impressão
    versionada, conflito explícito em 409 e escopo dentro da chave. Seis
    sabotagens, todas pegas — e uma delas mostrou que o dublê do próprio teste
    gravava de forma síncrona e por isso aprovava um serviço **sem
    serialização**.

31. **OS-101 — quatro achados do parecer independente, corrigidos na causa.**
    Uma revisão externa confrontou os arquivos enviados com as alegações da
    matriz e mediu o comportamento. Não apontou opinião: apontou defeito, com o
    número junto.
    (R01) A revisão independente percorria as etapas **presentes**, então
    `steps: []` ou só `build/PASSED` saía `CONFIRMED`, e as atestações eram
    conferidas por **presença de string**. Agora há contrato de etapas por
    perfil e a forma do resumo é conferida. **`AGT-04` foi rebaixado de
    `IMPLEMENTADA` para `PARCIAL`** — e continua `PARCIAL` depois da correção.
    (R02) O teto da missão pulava execução em voo: 1.200 relatados contra teto
    de 1.000 respondia `WITHIN, spent: 0`. O teto valia **depois** do gasto.
    (R03) A parada anunciava `cancelled` o que o registro de trabalhos chama de
    `requested`. Pedir não é provar.
    (R04) O portão de montagem aceitava **menção em comentário** como montagem.
    E a lição veio da falsificação: a sabotagem que tirava o contrato do
    `pipeline.ts` **sobreviveu** na primeira tentativa. A correção estava certa
    e a ligação com quem decide a entrega não estava sendo exercitada.
    Seguem abertos, do mesmo parecer: rotulagem de prova, workspace completo,
    Modo Empresa e RLS não ativada.

32. **OS-102 — a tarefa virou CONVERSA, e a home e a tarefa viraram uma jornada
    só.** O proprietário recusou a tela anterior com uma frase que não é sobre
    cor: *"ela ainda apresenta o assistente antigo de cinco etapas como
    estrutura principal"*. O que mudou aqui não é o tema — é onde as coisas
    moram.

    **A conversa não exigiu armazenamento novo, e essa é a parte que importa.**
    `GET /projects/:id` já devolvia pedido, turnos de admissão, plano,
    tentativas e evidências no mesmo corpo; a tela lia três desses campos e
    jogava fora `turns`, `runs` e `evidence`. Era o descarte, e não a falta de
    um diário, que fazia a conversa parecer impossível. `transcricao.ts` é uma
    função pura de corpo-da-tarefa para lances em ordem; `compositor.ts` é uma
    função pura de estado para destino do envio, e **nenhum estado devolve
    "abrir outra tarefa"** — é o requisito VIS-03 escrito como teste.

    O pipeline de cinco fases continua **inteiro** por baixo. Ele deixou de ser
    a moldura da tela e virou lógica interna: perguntas e plano aparecem na
    conversa, o progresso é compacto, e o detalhamento antigo — resultado,
    relato, pontos seguros e o trilho numerado — abre no painel lateral, que é
    a "visualização diagnóstica secundária" que a decisão permite.

    **Um contrato novo:** `POST /projects/:projectId/revise`. Continuar depois
    de um resultado não tinha onde acontecer (`plan/change` exige plano
    `PROPOSED`; depois de um desfecho ele está `APPROVED`), e sem ponto de
    extensão "continuar" teria de criar outro projeto — o defeito recusado. O
    pedido vira critério de aceite na especificação, com `origin: 'edit'`, que
    já existia no esquema para este caso. A versão do domínio **não** sobe. E a
    revisão não aprova nada: a pessoa ainda vê o plano novo e o aprova.

    **Os seis destinos entraram no trilho.** A regra anterior era "sem tela, sem
    linha"; a decisão inverteu: *"ausência de função significa implementar e
    manter a pendência"*. Habilidades e Plugins compartilham o Hub e mostram
    recortes disjuntos; Biblioteca é o acervo de pacotes exportados — não um
    apelido de Projetos; Agendado tem destino real, diz que a função não existe
    e o que falta, e está marcado `pendente` onde um teste alcança.

    **Nove achados saíram da execução, nenhum procurado.** Uma rota declarada e
    inalcançável (o casador de caminhos era uma segunda lista, e virou derivação
    do contrato). Uma ordenação de sufixos que era código morto — a sabotagem
    sobreviveu, e medir mostrou que a alternância do regex **retrocede**; o
    comentário que a justificava estava errado. Uma região que rola sem foco.
    Uma página sem marco principal e sem título. Um painel que escondia o
    `<main>` no celular. A mesma informação desenhada duas vezes em três
    lugares. E um plano devolvido para revisão que continuava editável, porque a
    tela guardava `null` em vez de ler o status do servidor.

    **Quatro sabotagens sobreviveram na primeira rodada**, e cada uma teve
    destino declarado: duas eram código morto ou redundância e saíram, duas eram
    buracos e viraram teste — inclusive um que afirmava uma regra com UMA
    especificação quando o laço começa na segunda, e por isso nunca a
    exercitava.

    **O que esta entrega NÃO prova:** semelhança visual é julgamento do
    proprietário — as capturas e a gravação em `apps/studio-web/capturas/` saem
    do build entregue e servem para comparar com F01/F16/F17, não para declarar
    aceite. O estado dos dados é tarefa criada na hora, no servidor de teste,
    com construtor **dublê**: prova de interface e de integração com o servidor
    de teste, **não** de geração com IA real nem do perfil Cordis. Os menus do
    compositor, o modal de preferências, compartilhar, uso e arquivos da tarefa
    ficam para a etapa seguinte, na ordem que a própria decisão manda.

33. **OS-103 — a CI estava vermelha há cinco entregas, e eu não tinha olhado.**
    O Prado mandou conferir a CI do `8de60fd`. Ela reprovou — e as quatro
    anteriores também, desde a OS-98. Eu vinha reportando "25 portões EXIT=0"
    entrega após entrega. Os portões locais passavam de verdade; **o verde era o
    da máquina errada**, e eu nunca abri a outra.

    **Primeira causa efetiva:** quatro erros de tipo com UMA origem.
    `plugins/action-approval` importava `@deepseek-ai/dsh-user-approval` sem
    declará-lo. O `import type` que amplia `Events` falhava, a chave do evento
    deixava de pertencer a `keyof Events`, e os dois parâmetros do ouvinte
    viravam `any` implícito. Passa aqui porque a árvore de links do pnpm alcança
    o que outro pacote declarou; reprova lá porque o clone limpo instala só o
    declarado. A correção é a declaração mais **três linhas** do lockfile — um
    `pnpm install` cheio reescrevia 43 linhas com churn de `supports-color` sem
    relação nenhuma com o defeito, e mexer em dependência por tentativa cega é
    o que o Prado proibiu em palavras.

    **A guarda é `gate:declared-imports`**, e ela fecha a classe, não o caso:
    lê o que está ESCRITO nos `src` e compara com o `package.json`. Não resolve
    módulo de propósito — resolver usaria justamente a árvore que esconde o
    defeito. Entrou nos portões **e no workflow da CI**.

    **Segunda causa:** o README não tinha a seção de clone novo que
    `clean-clone-readme.test.mjs` exige, e o job do Windows reprovava por isso.

    **Fidelidade visual.** Comparei a captura do build com F01 e F16 no mesmo
    viewport e escrevi as divergências uma a uma. Nove fecharam: a lateral
    mostra **tarefas reais** (de `GET /projects`, não uma lista de destinos com
    o nome errado), "Projetos" ganhou a ação de criar, a conta desceu para o
    rodapé com avatar de iniciais da sessão, o compositor virou pílula com envio
    redondo e a rota à esquerda, a conversa ganhou avatares e bolha, o
    compositor da tarefa ganhou o chip do projeto, e o alto da tela deixou de
    ser uma faixa vazia. **Onze continuam abertas e nomeadas** em
    `audit/fatias/2026-09-17-OS-103-fidelidade-visual.md` — busca, badge,
    pílula de créditos, ícones de provedor, anexo, microfone, estrelas,
    sugestões, menus do compositor, preferências e arquivos da tarefa. Cada uma
    com o motivo: quase todas são serviço que não existe, e desenhá-las seria o
    botão mudo que a decisão proíbe.

    **O defeito que o Prado apontou é real, e eu confirmei lendo o código:**
    depois de um resultado, todo envio virava critério de aceite permanente —
    inclusive uma pergunta. Nesta fatia o silêncio acabou (o compositor diz o
    que o envio vai fazer antes de a pessoa apertar), mas a correção completa é
    **T-34**: ligar a mensagem simples à conversa que já existe, para perguntar
    não custar tentativa. Não há atalho honesto, porque a decisão proíbe criar
    uma segunda conversa.

    **Registrado e NÃO implementado:** o ADENDO de uso, cotas e custos (**T-35**,
    nas quatro fatias do próprio adendo) e o DZ23 Studio Android via Capacitor
    (**T-36**, na ordem do próprio prompt). Registrar não é entregar.

    **A CI verde ainda não está comprovada.** O que confirmei localmente é que o
    erro de tipo sumiu e que `--frozen-lockfile` aceita o lockfile; a execução
    deste commit só existe depois do push.

34. **OS-104 — o teste passava aqui e reprovava lá, e o navegador era outro.**

    Com as duas causas da OS-103 corrigidas, o job Linux passou a rodar 12m18s
    em vez de morrer aos 4 min — e apareceu a falha que elas mascaravam: o
    teste de cookie de sessão exigia o nome `__Host-` no cabeçalho enviado.

    Em vez de supor, instalei o Chromium que a CI instala e medi os dois, no
    mesmo servidor e no mesmo endereço sem TLS: **133.0.6943.16 aceita `Secure`
    sobre http e RECUSA o prefixo `__Host-`; 141.0.7390.37 aceita os dois.** A
    diferença não é `*.localhost` ser contexto seguro — isso vale nas duas.

    Três coisas saíram daí. O comentário do produto, que afirmava em texto que
    o navegador aceita o prefixo, foi **corrigido** — tinha sido medido num
    navegador só. A consequência de produto virou **`IB-11`**, MEDIUM, ABERTA:
    onde o prefixo é recusado, o nome forte não é defesa, e a tranca da dona do
    Studio reabre por `Path=/api`. E a assimetria que escondeu tudo foi
    fechada: `playwright.config.ts` **recusa** um `DZ23_CHROMIUM_PATH` de
    compilação diferente da fixada, salvo declaração explícita.

    O teste foi partido em três — o que o servidor emite (sem navegador no
    meio), a capacidade do navegador (sonda com cookie próprio) e a asserção
    que corresponde à medida. Cobre os dois ramos, e a sabotagem que remove a
    emissão do nome forte agora é pega nas **duas** versões.

    O e2e desta entrega rodou no **Chromium da CI**. A CI verde continua sem
    comprovação até a execução deste commit.


35. **OS-105 — perguntar deixou de custar uma tentativa, e a V7 entrou uma vez.**

    O defeito que o Prado apontou era real: depois de um resultado, TODO envio
    virava critério de aceite permanente. Agora a tela **pede a escolha** — não
    adivinha —, e onde o defeito morava o padrão é "Perguntar". A pergunta é um
    lance da MESMA conversa, sem armazenamento novo. Achado do caminho: uma
    sabotagem SOBREVIVEU (a escolha morava num `return` de rota) e virou
    função exportada com teste.

    A **consolidação V7** foi registrada uma única vez, com o SHA-256 do MASTER
    conferido: `docs/inventory/master-v7.json` e `docs/status/CONSOLIDACAO_V7.md`.
    33 dos 36 contratos D7 estão `A_REVALIDAR_PELO_EXECUTOR` — **não conferido**,
    que é resposta diferente de ausente e de pronto.

36. **OS-106 e OS-107 — as Preferências, com a verdade ao lado de cada item.**

    Os treze itens de F04, cada um com o que ele É. Cinco funcionam; os outros
    declaram a pendência **sem controle nenhum**. O tema claro foi MEDIDO antes
    de construído: 506 cores fixas fora dos tokens — um seletor hoje pintaria
    metade da tela. Virou `V7-K`.

    E a **quinta causa da CI**: a própria suíte de capturas reescrevia PNGs
    versionados. `DZ23_CAPTURAS=sim` separa entrega de execução.

37. **OS-108 — os menus do compositor (F08/F09).**

    Com o que ESTE Studio tem ligado, e não os ícones das contas da referência.
    O F10 (seletor de computador) não entrou: seria botão mudo.

38. **OS-109 — o ADENDO de uso e custos, medido antes de construído.**

    A autoridade JÁ EXISTIA (`route-health` e `studio_runs`). Nenhum contador
    novo. O que faltava era apresentação: o painel "Uso e custos" da tarefa,
    onde **uso desconhecido não vira zero** e evento repetido não duplica custo.

39. **OS-110 — a Biblioteca declara o que guarda e o que faz.**

    Um tipo de arquivo, quatro operações que ela faz e **seis que ela não faz**,
    cada uma com o motivo. Módulo com teste, não parágrafo no JSX.

40. **OS-111 — a sexta causa da CI: região que rola sem foco.**

    O axe só cobra `scrollable-region-focusable` quando a região realmente
    rola, e isso depende do tamanho da janela. Passava aqui, reprovava lá. A
    guarda nova confere o atributo, sem depender de tamanho nenhum.

    **A CI fechou VERDE em `969482f` e `33245fe`** — as duas primeiras desde a
    OS-97, depois de seis causas, quatro delas da mesma família: o resultado
    dependia do ambiente de quem roda.

41. **OS-115 / BUS-01 — o MODO EMPRESA ganhou a primeira jornada completa.**

    A ação nova que uma pessoa passa a conseguir concluir: cadastrar a empresa
    com objetivo, público e limites, ver o plano **com a versão dele**, gravar
    uma versão nova sem apagar a anterior, e arquivar. Plugin novo
    (`plugins/business`), tela nova (`/studio/empresas`), montado no perfil —
    porque **existir no código não é existir em execução**.

    Nenhuma autoridade nova: a empresa mora dentro do escopo que `tenancy` já
    isola, e as rotas se penduram no manipulador de workspace do prompt-to-app.
    Três portões acharam buraco real no caminho (`domain-scopes`,
    `rls-coverage`, `image-lock`), e o teste de `storage-postgres` cobrou o
    registro nas rotas de domínio — sem ele as duas tabelas existiriam em
    execução e ficariam de fora do backup.

    Os outros **vinte e três** requisitos do bloco BUS continuam ausentes.

42. **BUS-02 — a tarefa nasce da empresa, com o plano dela dentro.**

    A jornada `empresa → objetivo → plano → tarefa` fecha: da tela da empresa,
    a pessoa escreve o que quer, escolhe o tipo e cria — e a tarefa que nasce é
    uma tarefa **de verdade**, criada pelo serviço de produção do prompt-to-app,
    com o plano da empresa dentro do briefing e o vínculo guardando **a versão
    do plano** que valia.

    Nenhuma segunda contabilidade de criação: a criação usa uma PORTA, e
    `request_key` atravessa inteira para quem já sabe tratá-la.

43. **A SÉTIMA causa de CI, e a QUINTA da mesma família.**

    O caso novo afirmava "você ainda não cadastrou nenhuma empresa" e passava
    aqui, rodado sozinho com `-g`, e reprovava lá, onde outro caso já havia
    cadastrado uma. A pré-condição era **acidental**; virou explícita.

    E a lição de processo, que custou uma entrega: rodar o caso novo sozinho
    prova que ele passa sozinho, e nada mais. **A suíte inteira é que prova que
    ele passa junto.**

44. **BUS-03 — a evidência volta para a empresa.**

    Cada tarefa da empresa mostra os pacotes que produziu, com tamanho, data e
    link de download. `empresa → objetivo → plano → tarefa → evidência` fecha.

    É uma **junção**, e não um registro novo: os pacotes já são guardados pelo
    `integration-hub`, com recibo e resumo criptográfico. Uma cópia deles aqui
    seria a segunda contabilidade de evidência — e a que divergisse em silêncio
    seria justamente a que alguém lê para decidir se o trabalho foi entregue.

45. **V7-C-2 — os dois últimos envios sem identidade de intenção fecharam.**

    Responder o questionário e pedir alteração no plano. Nenhum dos dois
    duplicava efeito **visível**, e era por isso que tinham ficado por último —
    só que "não duplica" era argumento, e não prova.

    O que a resposta duplicava era **custo**: com "recomendar" ela chama modelo.
    A chamada passou para dentro da chave; o contador de chamadas é a prova. O
    pedido de alteração devolvia um erro de repetição para quem só reenviou a
    mesma intenção — agora devolve o mesmo plano, e a guarda de estado continua
    intacta para quem manda outra.

    **Achado do e2e:** a primeira versão punha a pergunta corrente na impressão
    da resposta, e isso quebrava exatamente o caso para o qual a chave existe —
    o servidor calcula a pergunta a partir do que já foi respondido, então o
    primeiro envio a muda e o reenvio virava conflito. A razão ficou escrita no
    código, junto do que se perde ao tirá-la.

46. **T-35-ALCANCE — o alcance do ADENDO de uso e custos, medido critério a critério.**

    Onze critérios passaram com teste verde. E a medição achou um defeito no
    critério **central** do adendo, dentro do código escrito para cumpri-lo:
    `unpriced_requests` contava só chamada a rota sem preço, e não a chamada em
    que o provedor **não declarou uso** — nesse caso o registro afirmava
    "medido, custou zero" sobre custo inteiramente desconhecido. Um provedor que
    nunca declara uso parecia de graça. Consertado.

    Sobre concorrência eu esperava medir perda de escrita e **medi o
    contrário**. Ficou registrado como `NÃO OBSERVADO`, que não é aprovação: a
    corrida entre processos segue aberta.

    Quadro completo: [`docs/status/T35_ALCANCE.md`](T35_ALCANCE.md).

47. **V7-B-2 — a Biblioteca passou a versionar.**

    Cada tarefa numera os pacotes que produziu e diz o que mudou de um para o
    outro: cresceu, encolheu, ou é byte a byte o mesmo. Escolhida por
    pré-requisito — o motor já estava gravado, então versionar é **derivar**, e
    não guardar de novo.

    Duas sabotagens sobreviveram e viraram teste, e uma delas era a própria
    **declaração**: ela podia voltar a dizer "não suporta" sem que nada
    acusasse. E o rótulo declarado prometia *"guardar versões do mesmo pacote"*,
    que não é o que foi construído — corrigido, porque a declaração é lida como
    promessa.

48. **V7-A-2 — "Uso e custos" deixou de ser pendência, e a pendência estava errada.**

    Das oito seções pendentes das Preferências, uso foi a única cujo motor já
    estava inteiro — e a verificação do T-35 tinha acabado de prová-lo. O texto
    que estava na tela dizia *"a medição de uso ainda não foi construída"*.

    **Uma pendência que descreve errado o produto é uma segunda verdade com
    outra roupa:** quem a lê constrói de novo o que já existe.

    Nenhum contador novo — a rota repassa o que o `route-health` já grava. E as
    regras do adendo valem na camada que a pessoa lê: custo desconhecido sai em
    palavras, zero medido continua zero, e o total diz quantas chamadas ficaram
    de fora dele.

49. **V7-A-3 — atalhos de teclado, com um atalho de verdade.**

    A pendência dizia que não havia nenhum. Havia `Esc` em três lugares, e
    nenhum lugar que o dissesse — e listar os três não fecharia o requisito.

    A fatia acrescentou o que faltava: **`Ctrl+Enter` envia do compositor**, nos
    dois. `Enter` sozinho continua quebrando linha, e o e2e prova as duas
    metades — porque sequestrar o Enter é o defeito perigoso aqui.

    O atalho **não é uma segunda porta**: passa pela mesma condição do botão,
    inclusive o bloqueio de privacidade.

54. **INT-01 — três idiomas de verdade (adendo internacional R2).**
    Revalidei o diagnóstico no HEAD: 14 catálogos de interface e 19 de plugin,
    todos pt-BR, e **50 importações estáticas** — base de externalização, não
    seleção trilíngue. A camada existente foi expandida (contexto + catálogos
    estáticos), **sem** instalar biblioteca de i18n. Precedência de quatro
    degraus, com a corrida conta × escolha local resolvida pelo **instante**.
    `gate:idiomas` (29º portão) pega chave faltando/sobrando, tradução que é
    cópia, interpolação perdida e catálogo órfão. **Cobertura parcial e
    declarada na tela:** navegação e Preferências. Ver ADR-053.

53. **EMP-04 — o catálogo de ofertas (`BUS-03`), com a margem dizendo o que não sabe.**
    A empresa passou a dizer o que entrega, para quem, por quanto, com que
    capacidade e sob que condições — versionado, com a aprovação dentro da
    versão. As duas frases do fim do aceite viraram regra com nome próprio: a
    sugestão de preço devolve `aplicado: false` e **nunca** vira o preço, e a
    margem tem **três** estados (DESCONHECIDA, TETO, ESTIMADA), nenhum deles
    zero. A conferência da captura achou o rótulo em negrito dizendo "Margem
    estimada" sobre um teto; o rótulo passou a sair do mesmo estado.

52. **EMP-CORR — a colisão de rótulo com a matriz canônica, corrigida.**
    Três fatias do Modo Empresa saíram rotuladas `BUS-01..03`. Na matriz,
    `BUS-02` é pesquisa de mercado e `BUS-03` é oferta/catálogo/preço — quem
    lesse os dois lados concluiria que fecharam, e as duas continuam **sem uma
    linha de código**. A matriz **não** foi renumerada; o livro mestre passou a
    usar identificadores locais (`EMP-NN`) e
    `docs/status/BUS_CORRESPONDENCIA.md` diz por significado o que cada entrega
    toca e o que falta. `gate:bus-matriz` (o 28º portão) impede a volta.

51. **BR-F01..BR-F08 — a marca passou a ser FRIGG, e passou a ter UMA fonte.**
    A decisão `FRIGG-MARCA-20260917-R1` do titular trocou a marca visível. O
    nome estava escrito à mão em **onze lugares** que nenhum teste comparava
    entre si; agora ele mora em `apps/studio-web/src/marca/marca.ts` e
    `gate:marca` (o 27º portão) reprova qualquer superfície que discorde — e
    reprova também `id`, `scope` ou `start_url` do manifesto mudando junto,
    porque trocar a identidade de instalação faz o navegador tratar a PWA já
    instalada como outro aplicativo. A arte de cada tamanho foi **medida**
    (`audit/FRIGG_MARCA_R1/comparacao-marca.png`): o emblema sobrevive de 36 px
    para cima, o micro-F cobre o favicon, e o uso de cada um está declarado.
    `frigg.ia.br` é constante com `dominioPublicado: false`, e nada de DNS,
    TLS, cookie, RP ID, callback ou origem de API foi tocado. Ver ADR-052.

50. **V7-A-4 — levar consigo tudo o que é seu.**

    A pessoa baixa um arquivo com as tarefas, as conversas, as descrições, os
    planos, as tentativas e as provas — tudo do escopo dela, e nada de fora.

    A exportação **não abre caminho privilegiado de leitura**: ela percorre o
    mesmo `listProjects` que as telas usam. E o que a tarefa não tem vira
    `null`, não objeto vazio — quem receber o arquivo precisa da diferença.

    **Apagar continua fora**, e a tela diz por quê: é destrutivo e depende da
    sua decisão.


## Estado do DAG

**32 DONE, 3 PARCIAL, 2 BLOCKED.** As cinco que restam **não têm engenharia
pendente** — cada uma espera uma decisão do Prado ou um provedor real:

| tarefa | o que falta, e de quem é |
| --- | --- |
| T-17 | a porta de saída existe e está fechada (OS-94). Falta o Prado dizer **quais domínios** |
| T-19 | o teto em dinheiro existe e está ligado (OS-93, OS-95). Falta o Prado **preencher a tabela** e decidir se `NAO_MEDIDO` bloqueia ou avisa |
| T-32 | dois achados: um depende do **upstream**, o outro é a decisão de `edgeRequired` (OS-97 fechou a metade visível) |
| T-31 | `EB-08`: custódia de chave, decisão do Prado |
| T-16 | `EB-04`: provedor real, ou um modelo que responda ao prompt real em tempo utilizável |

## Próxima ação

Ver `docs/status/TASK_DAG.md`, tarefa de maior prioridade em `READY`.

## Regras que não mudam

- `integ` é a branch; `main` não é.
- Push é do Prado, pelo PowerShell: esta sessão recebe HTTP 403 do GitHub.
- Submódulo `third_party/deepseek-harness` é intocável.
- Nada declarado pronto sem evidência reproduzível.
