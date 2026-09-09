# C-05 — a decisão de licença, reduzida a duas perguntas

**Estado:** aguardando Prado. Este documento existe para que a resposta seja
curta e o resto seja mecânico.

**Aviso, e ele não é formalidade:** eu não sou advogado. O que está aqui é o
levantamento técnico do que o repositório contém e do que cada escolha
implicaria no código. A decisão é jurídica e comercial, é sua, e as minutas
abaixo servem para você levar a um advogado — não para publicar como estão.

---

## Pergunta 1 — qual licença

O `LICENSE.md` de hoje diz **"proprietário, todos os direitos reservados, não
redistribuível"**, e a **ADR-009 declara open source**. Os dois não podem estar
certos, e enquanto estiverem em desacordo ninguém sabe o que pode fazer com o
código — inclusive você.

| | o que ganha | o que abre mão |
|---|---|---|
| **Apache-2.0 + TRADEMARKS.md** *(minha recomendação)* | concessão explícita de patente, cláusula de marca separada, é o padrão que empresas aceitam sem revisão jurídica demorada | qualquer um pode usar comercialmente, inclusive um concorrente |
| **MIT** | mais curta e mais conhecida | **nenhuma** concessão de patente, e nenhuma proteção de marca |
| **BSL 1.1** | impede uso concorrente por N anos, depois vira open source | **não é OSI**; a ADR-009 teria de mudar, e alguns clientes recusam |
| **Continuar proprietário** | controle total | a ADR-009 teria de ser revogada, e o discurso de open source sai do produto |

**Por que Apache-2.0:** o DZ23 STUDIO gera aplicativos para terceiros. Sem
concessão de patente, quem adota carrega um risco que a MIT não endereça — e é
a primeira pergunta que o jurídico de um cliente maior faz. A TRADEMARKS.md
separada é o que impede alguém de pegar o código e chamar de "DZ23".

## Pergunta 2 — a que está acoplada, e é a que trava a publicação

O perfil do Studio depende de `@deepseek-ai/dsh-subagent-claude-code`, que
arrasta `@anthropic-ai/claude-agent-sdk` — **proprietário, "All rights
reserved", não redistribuível**.

**Enquanto essa dependência existir no perfil, nenhum artefato público pode ser
gerado, qualquer que seja a licença que você escolher.** `pnpm
gate:licenses:release` já reprova com essa mensagem. O modo normal só avisa,
porque trabalhar no repositório não é publicar.

| | consequência |
|---|---|
| **(a) tirar o subagente `claude-code` do perfil** | o artefato público passa a ser possível; o Studio perde o provedor `claude-code` (o `spawn-in-process` e o `codex` continuam) |
| **(b) manter, e o artefato fica privado** | nada muda no produto; a licença open source vale para o CÓDIGO, mas a imagem/pacote distribuível não sai |

As duas são legítimas. (a) é o caminho se publicar faz parte do plano; (b) é o
caminho se o open source é sobre o repositório e a distribuição é comercial.

---

## O que acontece no minuto em que você responder

Mecânico, e eu faço:

1. `LICENSE.md` reescrito com o texto integral da licença escolhida;
2. `NOTICE` criado, listando as obrigações de atribuição de cada dependência
   redistribuída (o `gate:licenses` já sabe enumerá-las);
3. `TRADEMARKS.md` criado a partir da minuta abaixo — **depois de revisão do
   seu advogado**;
4. cabeçalho SPDX em todo arquivo fonte do produto;
5. campo `license` em todo `package.json` de `plugins/` e `apps/`;
6. `docs/baselines/license-review.json` atualizado e `gate:licenses` religado
   no modo estrito;
7. se a resposta for (a): o subagente `claude-code` sai do perfil, e
   `gate:licenses:release` passa a poder passar.

## Minuta de TRADEMARKS.md — para o advogado, não para publicar

> As marcas "DZ23", "DZ23 STUDIO" e os logotipos associados são de LEANDRO
> MARCOS PRADO LTDA (CNPJ 64.339.333/0001-22) e **não** são licenciadas pela
> licença de software deste repositório.
>
> **Permitido sem autorização:** citar o nome para se referir a este projeto,
> inclusive em comparações e em documentação de integrações.
>
> **Não permitido sem autorização por escrito:** usar as marcas em nome de
> produto, domínio, aplicativo ou empresa derivados; apresentar uma versão
> modificada como sendo DZ23; sugerir origem, patrocínio ou endosso.
>
> Versões modificadas devem ser distribuídas sob outro nome.

*(Uma cláusula de marca precisa conversar com o registro no INPI. Se as marcas
ainda não estiverem depositadas, essa é a conversa que vem antes desta.)*
