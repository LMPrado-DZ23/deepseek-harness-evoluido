# CLAUDE.md — leia isto antes de qualquer coisa

Você está no **FRIGG** (ADR-052; o produto se chamou DZ23 STUDIO até 18/09/2026,
e os documentos históricos continuam dizendo isso de propósito — eles registram
o que aconteceu com o nome que a coisa tinha na época). Este arquivo é lido
automaticamente no início de toda sessão do Claude Code neste repositório. Ele
não é documentação: é a instrução de trabalho.

**Quem decide o produto é o Prado.** Ele não escreve código. Ele dirige
ferramentas de IA, decide arquitetura e produto, e trabalha em português do
Brasil. Responda em português do Brasil.

---

## 1. Ordem de leitura, na primeira coisa que você fizer

Não peça ao Prado para explicar o projeto de novo. Está tudo escrito:

| ordem | arquivo | o que ele responde |
| --- | --- | --- |
| 1 | `docs/status/PROJECT_STATUS.md` | **o arquivo de retomada** — onde a missão parou |
| 2 | `docs/status/TASK_DAG.md` | o que falta, e qual tarefa está `READY` agora |
| 3 | `docs/status/EXTERNAL_BLOCKERS.md` | o que depende do Prado, e o trabalho interno já feito |
| 4 | `docs/status/INTERNAL_BLOCKERS.md` | defeitos que dependem só de nós |
| 5 | `docs/PRODUCT_CONSTITUTION.md` | o que **não** se decide de novo |
| 6 | `docs/MASTER_REQUIREMENTS_LEDGER.md` | o livro mestre: cada entrega, com prova e limitação |
| 7 | `git log --oneline -20` | as últimas decisões, com o porquê no corpo |

Depois: `git status`, `git branch --show-current`.

`docs/OPERACAO.md` tem os comandos — como rodar cada portão e cada suíte, com
os caminhos e variáveis exatos.

---

## 2. Regras que não se negociam

Estas vêm do Prado e da constituição do produto. Nenhuma delas é flexível
porque o trabalho ficaria mais fácil.

**Nunca destrua.** Não apague worktrees, branches, bundles, backups nem
histórico. Não faça `reset` destrutivo, não limpe Docker, disco, temporários do
projeto nem `node_modules.partial-delete`. Não remova nem desrastreie
`plugins/*/lib/**`. **Acesso completo à pasta não autoriza efeito externo
destrutivo.**

**O upstream é intocável.** `third_party/deepseek-harness` está fixado em
`6c705be1ce6774a000d061da41d1823b03a3d42c`, com **zero diff**. `gate:upstream-pin`
prova. Nada do Zed entra no produto; nada depende do Roo Code encerrado.

**A branch é `integ`.** Nunca `main`. Confira com `git branch --show-current`.

**Publicar exige autorização específica do Prado.** Preparar pode; publicar
não. Isso inclui release pública, pacote publicado, imagem Docker pública,
tornar o repositório público e deploy. Push para `origin integ` é rotina.

**Nenhum segredo em lugar nenhum.** Nem em cliente, celular, prompt, log,
trace, arquivo gerado ou pacote. Só referências resolvidas por cofre.

**Nunca** instale CA raiz, intercepte TLS, altere `hosts`, ocupe a porta 443,
configure TPROXY/MITM, DNS ou proxy do sistema.

**9Router e OmniRoute nunca ficam ativos ao mesmo tempo.** OmniRoute é externo,
opcional, avançado e **desligado por padrão**; consome somente `/v1`.

**Nenhum componente BSL do Caveman** entra em artefato público ou serviço.
`gate:no-caveman` prova.

**Toda referência externa exige um P37 específico ANTES** de copiar código de
terceiro. `gate:p37` e `gate:vendored-references` provam.

**Confirme antes de apagar**, e antes de trocar a fonte ou a abordagem que o
Prado forneceu explicitamente. Se ele mandou um arquivo, não o substitua por um
equivalente sem perguntar.

**Continue sem pedir `continue`.** Decisão do Prado, 18/09/2026: checkpoint é
REGISTRO, e não pedido de permissão. Terminar uma fatia, aprovar uma suíte,
receber CI verde ou salvar um checkpoint **não** são motivos para encerrar a
resposta nem para perguntar se pode seguir. O ciclo é: salvar o estado nos
registros canônicos → escolher a próxima tarefa `READY` → **começar essa tarefa
nesta mesma resposta**. Anunciar que vai continuar não substitui continuar.

Isso muda a disciplina de trabalho, e **só** ela: não amplia escopo, não remove
controle de segurança, orçamento nem autorização sensível. As ações que
continuam exigindo a palavra dele estão logo abaixo, e nenhuma delas foi tocada.
Bloqueio externo numa frente não paralisa a missão — registre
`BLOCKED_BY_EXTERNAL_DEPENDENCY`, prepare o que dá para preparar sem ele, e siga
por outra tarefa independente. Pare só quando o escopo tiver prova, o Prado
cancelar, o recurso/sessão acabar de verdade, houver incidente, ou quando
sobrarem **apenas** dependências externas — e aí deixe entrega recuperável e um
resumo único.

**Nunca declare pronto sem a prova correspondente.** Isso vale para `READY`,
produção, celular validado, experiência para leigos validada e aplicação
finalizada. Não esconda falha ambiental, e não troque integração real por
dobro.

---

## 3. A disciplina que produziu este repositório

Ela não é estilo. É o que fez os defeitos aparecerem, e abandoná-la faz o
número de testes crescer sem que a confiança cresça junto.

### Falsificação obrigatória

Toda guarda nova é **sabotada** para confirmar que algum teste falha. Uma
guarda que sobrevive à sabotagem não está sendo exercitada por teste nenhum.

Os roteiros vivem em `/tmp/sab-*.sh` durante a sessão e **não** são versionados;
o que fica registrado é o número de sabotagens e o resultado, no livro mestre.

**Armadilha, já custou trabalho duas vezes:** o `git checkout -- arquivo` que
limpa a sabotagem restaura do ÍNDICE. Faça **`git add -A` antes** de rodar um
roteiro de sabotagem, ou você perde o que ainda não foi indexado.

Uma sabotagem que sobrevive tem três destinos, e só três:

1. **é buraco** → escreva o teste que lhe dá peso;
2. **é código morto** → remova;
3. **é genuinamente redundante** → **DECLARE** num comentário dizendo que a
   sabotagem sobrevive de propósito e por quê. Nunca finja cobertura.

### As lições que este repositório aprendeu, com custo

- **Se a decisão importa, ela não mora na montagem.** Código dentro de
  `apply()`, de um `return` de rota ou de um JSX não é exercitado por teste
  nenhum. Extraia para função exportada. Esta apareceu mais de dez vezes.
- **Os comentários longos justificavam decisões que a composição desfez.**
  Achado das três auditorias. Um comentário que explica uma razão que o código
  não tem é pior que nenhum: ele impede o próximo leitor de procurar.
- **Ausência de prova nunca vira prova.** `NÃO OBSERVADO`, `NÃO SEI` e `NÃO
  CONFERIDO` são respostas diferentes de "falhou" e de "passou", e colapsá-las
  manda a pessoa consertar o que talvez esteja certo.
- **Segunda verdade é o defeito mais caro daqui.** Duas descrições do mesmo
  fato divergem no primeiro conserto de uma delas — e a que diverge em silêncio
  costuma ser justamente a que alguém lê. Antes de construir um motor, **meça**:
  várias vezes a resposta honesta foi que ele já existia com outro nome.
- **Medir antes de consertar.** O buraco mais grave da missão (não havia como
  abrir o produto) e o defeito quadrático da varredura só apareceram porque
  alguém mediu em vez de supor.
- **Existir no código não é existir em execução.** A parada de emergência
  atravessou a missão inteira completa — domínio, serviço, rotas, tela, testes,
  dependência declarada no perfil — e **sem ser montada em perfil nenhum**. Os
  consumidores resolvem o serviço opcional com `ctx.get(...)` e seguem quando
  ele falta, o que está certo; o efeito combinado é que a tela mostrava o botão,
  as rotas não existiam e nada era bloqueado. Nenhum teste podia pegar: os
  testes do plugin testam o plugin, o e2e usa servidor de teste próprio e
  nenhum portão olhava montagem. `gate:profile-mounts` passou a olhar.
- **O artefato versionado é um segundo lugar onde a verdade mora.** `src/` está
  certo e `plugins/*/lib/` executa: quando os dois divergem, o conserto que
  todo mundo lê não é o código que roda. `gate:lib-freshness` compila e compara;
  antes dele, `tenancy/lib/` ficou vinte e tantos commits atrás do `src/` com
  uma correção de autorização parada dentro.

### Como uma entrega termina

1. **`pnpm gates`** — todos os portões e, no fim, a constituição sobre os
   vereditos que eles acabaram de gravar. A contagem NÃO está escrita aqui de
   propósito: o roteiro descobre a lista no `package.json`, e enquanto ela vivia
   escrita à mão em três lugares as três discordavam — `gate:licenses:release`
   existia e nenhuma sessão o rodava. `gate:typecheck` cobre os DOIS projetos, e
   ele existe porque o passo manual que dava para pular foi pulado nove vezes
   numa sessão só, e a nona entrega quebrou o dublê de e2e sem que nada acusasse;
2. a suíte da raiz, a de `studio-web`, o **e2e** e o **PostgreSQL** — as quatro,
   e não as duas mais baratas: o e2e é o único passo que roda o produto montado,
   e foi ele que pegou o dublê quebrado;
3. a falsificação, com o resultado de cada sabotagem;
4. uma linha nova em `docs/MASTER_REQUIREMENTS_LEDGER.md`, com **prova** e
   **limitação declarada**;
5. `docs/status/PROJECT_STATUS.md` e `docs/status/TASK_DAG.md` atualizados;
6. commit cujo corpo explica **por quê**, e não o quê.

O livro mestre tem portão (`gate:requirements-ledger`) e ele confere a
contagem: uma linha nova exige atualizar os totais no fim do arquivo.

---

## 4. O que este projeto ainda não é

Além das falhas internas e funcionalidades pendentes registradas no DAG,
faltam estas validações:

- **Ninguém que não programa jamais usou o produto** (`EB-02`). Nenhum dos
  milhares de testes substitui isso.
- **Uma jornada real não certifica o produto inteiro.** `JORNADA-REAL-01`
  registra em 20/09/2026 o contador criado com Mistral, a prévia, a alteração
  na mesma conversa e o reinício do processo. Consultar `CURRENT VERIFIED
  STATE` em `PROJECT_STATUS.md` para a distinção entre registro externo e
  revalidação nesta sessão; reinício do computador e demais jornadas pendentes.

Não chame o produto de pronto enquanto os critérios de aceite e as pendências
canônicas não estiverem resolvidos.

---

## 5. Atribuição dos commits

Termine toda mensagem de commit com:

```
Co-Authored-By: Claude <noreply@anthropic.com>
```
