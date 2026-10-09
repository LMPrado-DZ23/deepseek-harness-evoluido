# M6.8 — CI de clone limpo e PostgreSQL real

Estado: **IMPLEMENTED / REMOTE EXECUTION NOT_EXECUTED**

## Objetivo

Impedir que uma árvore que só funciona no checkout do desenvolvedor seja
aceita como verificável. O workflow parte de checkout novo, materializa o
submodule fixado, compila Harness e Studio antes do typecheck/testes e executa
separadamente todo teste que declara a dependência de PostgreSQL real.

## Propriedades do gate

- permissões GitHub somente de leitura e credenciais não persistidas;
- actions fixadas por SHA completo;
- Node 22.23.1 e pnpm 11.7.0 fixados;
- PostgreSQL 16 em serviço efêmero com a imagem já fixada no repositório;
- suíte sem banco com dois workers, conforme a prova M6.7;
- descoberta automática das specs PostgreSQL pelo contrato
  `DZ23_POSTGRES_TEST_DSN`, com falha se o conjunto ficar vazio;
- modo `--list` verificável sem servidor para tornar a seleção visível no log;
- recusa de mutação da árvore fora de `plugins/*/lib/**`.
- job Windows separado com 16 contratos herméticos de imagem, runtime e
  preflight; ele não inicia Docker, WSL ou serviços.

A exclusão temporária de `plugins/*/lib/**` no último item não declara esses
artefatos aceitáveis: 95 arquivos ainda estão rastreados e 42 mudam no build.
Ela apenas mantém o CI utilizável enquanto a remoção estrutural aguarda decisão
do proprietário. Depois dessa autorização, a exclusão deve ser removida e o
workflow deve exigir árvore completamente limpa.

## Evidência e limite

Os comandos equivalentes de install/build/typecheck/test foram executados em
clone limpo WSL2/ext4 na prova M6.7. O arquivo do workflow foi criado e revisado
localmente. A descoberta selecionou as seis specs PostgreSQL atuais e seus três
testes de seleção/ordenação, conjunto vazio e entradas ambíguas passaram. O YAML
foi analisado com sucesso e os três SHAs das actions foram confrontados com os
tags remotos oficiais em 06/09/2026.

Os mesmos três arquivos do job Windows passaram no Windows 11 local: **16/16**.
Isso prova seus contratos e o preflight simulado; instalação, update, rollback,
uninstall, WSL2 e Docker reais continuam fora desse job e permanecem
`NOT_EXECUTED` até a prova física autorizada.

Não existe remoto configurado; por isso uma execução real do GitHub Actions
permanece `NOT_EXECUTED` e não pode ser chamada de PASS. O serviço PostgreSQL do
workflow também não substitui a execução independente solicitada ao Claude.
