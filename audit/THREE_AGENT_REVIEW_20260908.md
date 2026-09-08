# Auditoria independente das fatias M90-A/B/C e M75-C (08/09/2026)

**Faixa auditada:** `git diff 61ba89e` na branch `claude/integration-candidate-20260907`
**Auditores:** três agentes independentes, sem acesso às conclusões uns dos outros.

Os três rodaram sobre o código real: leram, executaram testes focados e
escreveram scripts de prova. **Dois deles encontraram, de forma independente, o
mesmo CRITICAL** — o que é o sinal mais forte de que ele era real.

## CRITICAL

### CR-1 — Uma confirmação humana virava N execuções T3 · **CORRIGIDO**
*Auditor A (C1) e Auditor B (HIGH-1), independentemente.*

`plugins/assistant-bridge/src/approval.ts` derivava a reivindicação do consumo
de `(ação, tentativa)`:

```ts
claimId: `${input.action}:${String(attempt)}`
```

Isso não identifica uma **execução**; identifica uma **posição no laço**. Duas
chamadas concorrentes da mesma operação sensível caíam no mesmo `approval_id`
(idempotência correta do pedido) **e** na mesma reivindicação, então a segunda
entrava no ramo de repetição idempotente do consumo e recebia o mesmo recibo. O
mutex serializava, mas não salvava: garantia que só uma escrevesse, não que só
uma recebesse permissão.

O Auditor B demonstrou com N = 10: uma pessoa confirma uma vez, dez execuções
sensíveis começam. O caminho sequencial estava correto — por isso nenhum teste
pegava.

**Correção:** `claimId: \`run-${randomUUID()}\`` — a reivindicação identifica a
execução. A segunda diverge e o consumo recusa. O respondedor do Harness já
fazia o certo; o bridge era a exceção.

**Regressão:** duas chamadas idênticas em paralelo, uma confirmação, e a prova
exige **exatamente uma** execução. A mutação que devolve o valor determinístico
derruba dois testes.

## HIGH

### HI-1 — O encerramento ativo NÃO rodava antes do fechamento do armazenamento · **CORRIGIDO**
*Auditor A (H1).*

O comentário afirmava que dois efeitos separados seriam descartados na ordem
inversa. **Falso:** o cordis dispara os disposers com `Promise.all`, ou seja,
concorrentemente. O fechamento do domínio marca `disposing` de forma síncrona e
passa a recusar escritas, enquanto o encerramento ainda esperava até 15 s pelas
execuções em voo — e tudo que ele gravasse era rejeitado. O resultado era
exatamente o estado que o M75-C existe para evitar.

Pior: **o teste simulava a ordem**. Ele sequencializava com um laço próprio o
que o runtime paraleliza, e então afirmava a ordem que ele mesmo tinha
produzido. Era um mock apresentado como prova de ciclo de vida.

**Correção:** um único disposer que faz `await service.shutdown()` e só então
fecha os domínios. **O teste passou a usar `Promise.all`**, como o runtime, e a
exigir que o encerramento TERMINE antes de a primeira porta do armazenamento
fechar. Duas mutações (inverter a ordem; não chamar o encerramento) derrubam.

### HI-2 — O `lib/` versionado não resolvia num clone limpo · **CORRIGIDO**
*Auditor A (H2) e Auditor B (MEDIUM-5).*

`plugins/assistant-bridge/lib/index.js` está **versionado** e passou a importar
`./approval.js`, que caiu no `.gitignore`. Um clone limpo quebrava com
`ERR_MODULE_NOT_FOUND`. Funcionava aqui só porque o `lib/` local tinha sido
construído. A auditoria também achou o mesmo em `identity`, `runtime-governor` e
`storage-postgres` — **defeito pré-existente**, não introduzido por esta fatia.

Os dois auditores sugeriram desrastrear o `lib/`. Isso é **proibido** por
instrução explícita do Prado, então a correção foi a inversa e igualmente
consistente: os 57 arquivos que faltavam foram adicionados, e agora todo `lib/`
versionado resolve seus próprios imports.

**Portão novo:** `scripts/check-tracked-lib.mjs` (`pnpm run gate:tracked-lib`)
lê o **índice do git**, nunca o disco, e reprova quando um `.js` versionado
importa um arquivo que o repositório não tem. Tem self-test negativo, e foi
provado contra o defeito real: removendo `approval.js` do índice, ele reprova.

### HI-3 — Corrida de montagem desligava o portão T3 em silêncio · **CORRIGIDO**
*Auditor A (H3) e Auditor B (LOW-1).*

`ctx.get('studioActionApproval')` era capturado no `apply`. `ctx.get` é um
instantâneo sem reatividade, e a ordem de montagem entre plugins não é
garantida: se a autoridade subisse depois, **toda** operação T3 recusava com
`NOT_CONFIGURED` para sempre e `/studio/approvals` respondia 503, sem sinal
nenhum. Falhava fechado — mas era perda total da funcionalidade, silenciosa.

**Correção:** o serviço é resolvido **a cada uso**, nunca capturado. Prova: uma
autoridade que sobe DEPOIS do bridge passa a ser encontrada. A mutação que volta
a capturar na montagem derruba o teste.

### HI-4 — A pessoa confirmava às cegas · **CORRIGIDO**
*Auditor B (HIGH-2), Auditor C (C1) e Auditor A (M1) — três, independentemente.*

O que chegava à tela era `{approval_id, state, action, subject_id, tier}`. A
instrução, os caminhos e o motivo dado pelo modelo viviam **apenas dentro da
impressão digital** (SHA-256), que de propósito não sai. O vínculo era sólido —
confirmar A e executar B era impossível — mas a pessoa não tinha como saber **o
que** estava autorizando.

O Auditor B demonstrou o ataque: duas linhas byte-a-byte idênticas em tudo que a
tela mostrava, uma delas plantada por injeção. No caminho do Harness era pior:
"usar a ferramenta bash" **sem mostrar o comando** é indistinguível de um botão
"sim para tudo".

**Correção:** o registro ganhou um campo `summary` — uma frase derivada **no
servidor**, higienizada, limitada a 300 caracteres, **coberta pela impressão
digital** (o texto exibido é o texto que a confirmação tranca) e devolvida pela
visão pública. O domínio subiu para a versão 2. A tela mostra a frase antes de
tudo. A impressão digital continua sem sair.

### HI-5 — Modo escuro: o título e a explicação da tela de autorização sumiam · **CORRIGIDO**
*Auditor C (H2).*

A folha **não tem `:root` escuro**. As regras novas clareavam a cor do texto sem
nenhum fundo escuro atrás, resultando em ~1,4:1 sobre o branco — onde o mínimo é
4,5:1. "Precisa da sua confirmação" e "Nada acontece enquanto você não decidir"
sumiam, e a pessoa via botões de autorizar e recusar flutuando sem título.

O guarda de contraste só verificava um sentido ("escureceu o fundo, declarou a
cor?"). O sentido inverso — "clareou o texto, tem fundo escuro?" — não existia.

**Correção:** `.approvals` e `.stuck-runs` ganharam superfície escura própria, e
o guarda ganhou a verificação inversa, **por família**, porque o CSS sozinho não
diz quem é filho de quem. O guarda novo achou na hora um defeito
**pré-existente**: `.conversation` clareava o texto da conversa inteira sem
fundo escuro. Corrigido junto.

### HI-6 a HI-9 — Verdade e saída na tela · **CORRIGIDOS**
*Auditor C (C2, C3, H1, H3, H4, H5, H6).*

- **"O assistente está seguindo daqui" era mentira** nas operações do bridge: o
  portão não espera, ele devolve o controle ao modelo. Texto trocado por "Volte
  à conversa e peça ao assistente para continuar".
- **O pedido sumia em silêncio ao vencer.** Agora o prazo aparece no cartão.
- **`NOT_CONFIGURED` cru na tela**, com um botão "Ver de novo" que nunca ia
  resolver. As três mensagens foram reescritas em português de gente, dizendo o
  que fazer ("peça a quem administra o Studio para ativar").
- **"Registrando sua decisão…" aparecia no botão _Autorizar_ quando a pessoa
  clicava em _Não autorizar_** — numa tela de segurança, a leitura natural é que
  o sistema inverteu a decisão. Agora o estado fica no botão clicado, com textos
  distintos, e `aria-busy` no item.
- **Recusar não avisava nada, nem antes nem depois.** Agora avisa que é
  definitivo, e confirma depois que foi registrado.
- **A tela afirmava "Nada esperando por você agora" antes de ter lido
  qualquer coisa.** Agora existe o estado "Verificando…".
- **`studio.agent.resolve-unknown` aparecia com o nome técnico**, justamente no
  único fluxo em que a interface MANDA a pessoa provocar uma confirmação. Tem
  rótulo, e um teste exige rótulo para **toda** ação sensível.

## MEDIUM corrigidos

- **Pedido vencido voltava como aberto** (A-M2, B-MEDIUM-2): `#requestLocked`
  não expirava na leitura, então o modelo apontava para um id morto que a tela
  já não mostrava, e a operação ficava presa. Agora expira na leitura, e uma
  falha ao GRAVAR o vencimento não faz o pedido voltar como aberto.
- **Um pedido em andamento congelava os botões de todos os outros** (C-M2).
- **403 de escopo era apresentado como "falta a chave de acesso"** (C-M1): o
  servidor passou a mandar o código do erro, e só `STRONG_IDENTITY_REQUIRED`
  vale tentar de novo.
- **Identificadores longos estouravam a tela no celular** (C-M6):
  `overflow-wrap`.
- **Título afirmava trabalho parado quando a leitura falhou** (C-M8).
- **Os dois botões competiam visualmente** (C-M5): largura e cor corrigidas.

## Aceitos e NÃO corrigidos — registrados como limitação honesta

| Achado | Por que fica |
|---|---|
| **B-MEDIUM-1: o nível T3 é auto-declarado pelo modelo.** `studio_agent_start` (T2) executa a mesma coisa que a versão sensível; os sinalizadores só calculam o nível, não trocam sandbox nem credencial. | **Pré-existente a `f1677b4`**, e é o limite superior real desta fatia. Corrigir exige derivar sensibilidade de capacidade verificável (sandbox, credencial montada, egresso), o que é uma fatia própria. **A linha do `CAPABILITY_MATRIX` foi corrigida para dizer isso.** |
| **A-M4 / B-MEDIUM-4: a escrita condicional só vale em um processo.** O seam de domínio só oferece `put(chave, valor)`; a atomicidade vem de um mutex em memória. | Já documentado em `mutex.ts`. Exige CAS durável no seam antes de qualquer implantação com réplicas. **Registrado no `CAPABILITY_MATRIX` como "instância única".** |
| **A-M3 / B-MEDIUM-3: `MAX_APPROVAL_ATTEMPTS` esgotável; sem cota nem purga.** | Exige contador durável ou purga por TTL de armazenamento. A mensagem foi reescrita para não culpar a pessoa. |
| **A-M5: corrida `listOpen` × `confirm` vira 500 em vez de 410.** | Perda de sinal, não de segurança. |
| **A-L1: a lista de execuções paradas escopa por organização e inquilino, não por espaço de trabalho.** | O Auditor B refutou como vazamento: `workspaceId !== tenantId` é recusado na configuração, então o filtro é equivalente hoje. Fica a nota para o dia em que o invariante mudar. |
| **C-M3/M4: nada avisa que um pedido chegou; autorizações só existem dentro da tela de conversa.** | Indicador global é uma fatia de navegação. |
| **Tema escuro do resto do aplicativo** (`.status`, `.truth`, `.task-card`, `.preview-card`, `.assistant-entry`, cartões de design) declara fundo claro sem cor própria. | Achado **pré-existente** exposto pelo guarda novo. Consertar exige um `:root` escuro e revisão de todas as telas — fatia própria, e sem navegador aqui seria trabalho às cegas. |

## Estado depois das correções

- `tsc --noEmit` **PASS** (raiz e `apps/studio-web`), sem nenhum cast de escape
- `pnpm build` **PASS**
- Suíte completa com **PostgreSQL 16.13 real**: **2200 aprovados**, 60 pulados,
  3 reprovados apenas por rodar como uid 0 (os mesmos três arquivos passam
  103/103 como usuário não privilegiado)
- Cobertura: **zero violações de limiar** (96,08% stmts / 93,55% branches)
- `ASSISTANT_TOOL_CATALOG=PASS tools=14` · `I18N_GATE=PASS catalogs=15`
- `DOMAIN_ROUTE_GATE=PASS domains=26` · `domain-scopes` PASS
- `TRACKED_LIB=PASS files=170 findings=0` (portão novo)
- `PORTABILITY=PASS findings=0` · `UPSTREAM_PIN=PASS commit=6c705be1`
- **P37** `PASS · 473 arquivos · 19 manifests · 1 licença · 0 achados`

**CRITICAL abertos: 0. HIGH abertos: 0.**
