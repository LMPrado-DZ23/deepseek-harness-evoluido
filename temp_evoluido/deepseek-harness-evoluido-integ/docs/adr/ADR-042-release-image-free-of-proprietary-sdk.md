# ADR-042 — A imagem distribuível deixou de arrastar SDK proprietário

- Estado: Aceita
- Data: 2026-09-09
- Autor: Claude (Opus 5), dentro da autonomia delegada por Prado ("quero atacar os dois, você decide a ordem")
- Requisito correspondente: `C-05`
- Antecede: [ADR-041](./ADR-041-apache-2-license-applied.md)

## Contexto

A ADR-041 aplicou Apache-2.0 ao **código** e deixou explícito o que ela não
resolvia: `bloqueiam_publicacao=2`, porque o artefato distribuível arrastava
`@anthropic-ai/claude-agent-sdk`, proprietário e não redistribuível. Licença do
código aberta, imagem impublicável — duas coisas diferentes, e o repositório
sabia disso.

O `docs/plans/C-05-decisao-de-licenca.md` ofereceu duas saídas, e a primeira
estava escrita assim: *"tirar o subagente `claude-code` do perfil"*.

**Essa frase estava errada, e este ADR existe porque ela estava errada.**

Duas descobertas, ambas verificadas antes de qualquer mudança:

1. `@deepseek-ai/dsh-subagent-claude-code` é um **pacote de workspace do Harness
   fixado**, casado pelo padrão `third_party/deepseek-harness/packages/*/*`. Ele
   entra na instalação por ser workspace, **não** por estar citado no perfil.
   Tirar do perfil não tira do lockfile, e portanto não tira da imagem.
2. O `gate:licenses` media a **árvore errada**: `node_modules` (o que a máquina
   de desenvolvimento tem) em vez de `pnpm-lock.release.yaml` (o que vira o
   artefato). Um portão que mede uma coisa e afirma outra passa verde sobre um
   bloqueio real.

## Decisão

**O subagente `claude-code` está excluído das duas topologias pnpm, e o portão
de licença de release passou a ler o lockfile de release.**

Concretamente:

- `- '!third_party/deepseek-harness/packages/subagent/subagent-claude-code'` em
  `pnpm-workspace.yaml` **e** em `pnpm-workspace.release.yaml`. Nas duas, não só
  na de release: `scripts/check-image-lock.mjs::validateWorkspaceTopologies`
  exige que os dois arquivos sejam idênticos exceto pela flag
  `injectWorkspacePackages`. A regra é chata de propósito, e aqui ela produziu o
  resultado mais honesto: **o que é testado é o que é publicado**. Excluir só na
  release deixaria o desenvolvimento exercitando um caminho que o artefato não
  tem.
- `scripts/check-release-licenses.mjs` ganhou `packagesInReleaseLock(lock)`. O
  laço de bloqueio-para-release agora decide pelo lockfile de release, não por
  `node_modules`.
- O perfil `dsh-home/profiles/studio` deixou de declarar o subagente, e
  `cordis.patch.yml` explica a ausência em vez de simplesmente não citar nada.
- O caminho de volta ficou **documentado e verificável**:
  `dsh-home/profiles/studio/optional/claude-code.patch.yml` é o trecho que
  quem quiser o subagente aplica localmente, com a consequência escrita ao lado
  (a instalação resultante não é redistribuível).

## Consequências

- `grep -c "claude-agent-sdk" pnpm-lock.release.yaml` → **0**.
- `RELEASE_LICENSES=PASS pacotes=848 proprios=2 proibidas=0 sem_revisao=0
  bloqueiam_publicacao=0 revisadas=6 modo=release`.
- O passo de release-license na CI **deixou de ser `continue-on-error`**. Ele era
  informativo porque a decisão era do Prado e ainda não tinha sido tomada.
  Tomada a decisão, um passo que avisa e segue verde é um passo que ensina a
  ignorar: se o SDK voltar ao lockfile de release, a CI reprova.
- `scripts/prove-fase3-agents.mjs` agora afirma a **ausência**:
  `assert.equal(subagents.includes('claude-code'), false, ...)`. Sem isso, o
  subagente voltaria em silêncio no dia em que alguém regenerasse o perfil.
- **Perda real, declarada:** a instalação padrão não tem o subagente
  `claude-code`. Quem depende dele aplica o opt-in e aceita que sua instalação
  não pode ser redistribuída. Trocamos uma capacidade opcional por uma imagem
  publicável, e essa é a troca que o open source exigia.

## Falsificação

Um portão que só passa não prova nada. Injetamos `@anthropic-ai/claude-agent-sdk`
de volta em `pnpm-lock.release.yaml`:

```
RELEASE_LICENSES=FAIL ... bloqueiam_publicacao=1
```

Restaurado o lockfile, `PASS`. O portão reprova pelo motivo certo.

## O que este ADR NÃO decide

Ele não substitui a confirmação jurídica do Prado sobre a Apache-2.0, nem a
revisão de advogado sobre `TRADEMARKS.md`, que continuam pendentes desde a
ADR-041. Este ADR remove o bloqueio **técnico** à publicação da imagem; o
bloqueio **jurídico** é de outra natureza e não é meu para resolver.
