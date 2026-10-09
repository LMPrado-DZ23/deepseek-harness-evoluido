# Licença — DZ23 STUDIO

O código deste repositório é licenciado sob a **Apache License 2.0**. O texto
integral e vinculante está em [`LICENSE`](./LICENSE); este arquivo é apenas um
resumo em português e **não** substitui aquele texto.

## O que a licença permite

Usar, copiar, modificar, distribuir e usar comercialmente, inclusive em produto
fechado, desde que você mantenha o aviso de copyright, o `NOTICE` e indique as
alterações que fez.

A Apache-2.0 foi escolhida (ADR-009 e `docs/plans/C-05-decisao-de-licenca.md`) por
causa da **concessão explícita de patente**: este projeto gera aplicativos que
terceiros vão operar, e uma licença sem essa concessão transferiria um risco para
quem adota.

## O que a licença NÃO cobre

**As marcas.** "DZ23", "DZ23 STUDIO" e os logotipos associados pertencem a
LEANDRO MARCOS PRADO LTDA e não são licenciados aqui. Veja
[`TRADEMARKS.md`](./TRADEMARKS.md).

**As dependências.** Cada componente de terceiros permanece sob a própria
licença. As atribuições exigidas estão em [`NOTICE`](./NOTICE), e
`pnpm gate:licenses` enumera o conjunto.

**O submódulo `third_party/deepseek-harness`.** Ele é o DeepSeek Harness, não é
obra deste projeto, está fixado por commit e **não é modificado**. A licença dele
é a que vale para ele.

## Sobre o artefato distribuível

O perfil de execução depende de `@deepseek-ai/dsh-subagent-claude-code`, que
arrasta um pacote proprietário e não redistribuível. Por isso
`pnpm gate:licenses:release` reprova a geração de artefato público enquanto essa
dependência estiver no perfil.

**A licença do CÓDIGO é aberta; a IMAGEM distribuível ainda não pode ser
publicada.** As duas coisas são diferentes, e confundi-las seria o tipo de
afirmação que este repositório evita. A escolha entre remover o subagente do
perfil ou manter a distribuição privada está descrita em
`docs/plans/C-05-decisao-de-licenca.md`.
