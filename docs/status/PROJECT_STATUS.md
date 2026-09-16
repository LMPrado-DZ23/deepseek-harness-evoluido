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
- `atualizado_em`: 2026-09-12

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
| suíte raiz | 3412 testes, 197 arquivos, 0 falha (12/09, após OS-76) | `pnpm -w test` |
| suíte studio-web | 507 testes | `cd apps/studio-web && npx vitest run` |
| e2e navegador | 117 aprovados, 0 reprovados, 5 pulados (12/09, quatro tamanhos) | `cd apps/studio-web && npx playwright test` |
| PostgreSQL real | **65 testes, `POSTGRES_GATE=PASS`** (12/09, PostgreSQL 16.13 local) | `pnpm test:postgres` |
| portões | **21/21 PASS** | ver abaixo |

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

## Próxima ação

Ver `docs/status/TASK_DAG.md`, tarefa de maior prioridade em `READY`.

## Regras que não mudam

- `integ` é a branch; `main` não é.
- Push é do Prado, pelo PowerShell: esta sessão recebe HTTP 403 do GitHub.
- Submódulo `third_party/deepseek-harness` é intocável.
- Nada declarado pronto sem evidência reproduzível.
