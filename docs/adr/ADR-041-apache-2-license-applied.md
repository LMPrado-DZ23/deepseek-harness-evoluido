# ADR-041 — A licença Apache-2.0 aplicada, e o que ela ainda não resolve

Data: 09/09/2026. Estado: aceito, **pendente de confirmação jurídica do Prado**.
Autor: Claude (Opus 5), a pedido de Prado ("prepare esse repositório para ser
open source, deixe tudo pronto").
Requisito correspondente: `C-05`. Estudo prévio: `docs/plans/C-05-decisao-de-licenca.md`.

## Contexto

A [ADR-009](./ADR-009-open-source-without-billing.md) decidiu, em 02/09/2026, que
o DZ23 STUDIO seria **open source e sem cobrança**. A licença OSI exata ficou em
aberto, e ficou aberta por sete dias.

Enquanto isso, o `LICENSE.md` do repositório dizia **"proprietário, todos os
direitos reservados, não redistribuível"**. Os dois documentos não podiam estar
certos ao mesmo tempo, e enquanto estivessem em desacordo ninguém sabia o que
podia fazer com o código — inclusive o próprio dono.

O `docs/plans/C-05-decisao-de-licenca.md` reduziu isso a duas perguntas e
recomendou **Apache-2.0 + TRADEMARKS.md**. O Prado pediu o repositório pronto
para publicação, o que exige que a primeira pergunta esteja respondida.

## Decisão

**Apache-2.0 aplicada ao código deste repositório.**

O texto integral e não modificado está em `LICENSE`, buscado da fonte canônica
(`https://www.apache.org/licenses/LICENSE-2.0.txt`) e não redigido de memória —
um erro de transcrição num texto jurídico não é um erro de digitação. O único
campo preenchido foi o titular do copyright.

Acompanham:

- `LICENSE.md` — resumo em português, que **não** substitui o texto vinculante;
- `NOTICE` — atribuição, com o submódulo do Harness nomeado como obra de
  terceiro não modificada;
- `TRADEMARKS.md` — minuta da cláusula de marca;
- campo `license: "Apache-2.0"` em 23 manifestos (`plugins/*`, `apps/*` e raiz).

### Por que Apache-2.0, e não MIT

O DZ23 STUDIO **gera aplicativos que terceiros vão operar**. A MIT não concede
patente; quem adota carrega um risco que a licença não endereça, e essa é a
primeira pergunta que o jurídico de um cliente maior faz. A cláusula de marca
separada é o que impede alguém de pegar o código e continuar chamando de "DZ23".

## O que esta ADR NÃO decide, e é importante não confundir

**1. A pergunta 2 do C-05 continua aberta.** O perfil de execução depende de
`@deepseek-ai/dsh-subagent-claude-code`, que arrasta um pacote proprietário e não
redistribuível. `pnpm gate:licenses:release` reprova a geração de artefato
público por causa disso — hoje, `bloqueiam_publicacao=2`.

> A licença do **CÓDIGO** é aberta. A **IMAGEM** distribuível ainda não pode ser
> publicada. São coisas diferentes, e apresentá-las como uma só seria o tipo de
> afirmação boa demais que este repositório existe para não fazer.

A escolha entre (a) tirar o subagente do perfil e (b) manter a distribuição
privada é de produto, é do Prado, e continua no `C-05`.

**2. A cláusula de marca não passou por advogado.** O `TRADEMARKS.md` diz isso na
primeira linha. Uma cláusula de marca precisa conversar com o registro no INPI;
se as marcas ainda não estiverem depositadas, essa conversa vem antes.

**3. Eu não sou advogado.** Esta ADR registra uma decisão técnica tomada dentro
da autonomia que o Prado delegou, sobre uma recomendação que já estava escrita e
fundamentada. Ela é **reversível enquanto o repositório for privado** — trocar a
licença depois da publicação não é.

## Consequências

- O repositório deixa de se contradizer: `LICENSE`, ADR-009 e README dizem a
  mesma coisa.
- Quem clonar sabe o que pode fazer.
- Uma bifurcação é legítima e deve circular com outro nome (TRADEMARKS.md).
- O `C-05` sai de `FAILED` e passa a `BETA`: a licença está **aplicada e
  verificável no repositório**, e falta a confirmação jurídica de quem é dono
  dela.

## Como reverter

`git revert` do commit que aplicou, enquanto o repositório for privado. Depois de
uma publicação pública, a licença concedida naquela versão não volta atrás — e é
por isso que a confirmação do Prado é o próximo passo, e não uma formalidade.
