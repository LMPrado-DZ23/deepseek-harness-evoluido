# S-08 — o que falta migrar, e como

Data: 09/09/2026. Estado: **plano**, não execução.
Decisão do alvo: [ADR-044](../adr/ADR-044-alvo-alcancavel-de-rls.md).

## Os cinco

`studio_app_specs`, `studio_design_specs`, `studio_intake_turns`,
`studio_plans`, `studio_evidence`.

Eles são os únicos pendentes cuja barreira é **forma de código**, e não
estrutura. Nenhum é tocado pela varredura de reinício — conferido em
`reconcileInterruptedExecutions`, que lê `runs()` e `projects()` e escreve em
`putRun`, `putApproval` e `putProject`, e mais nada.

O que os prende é que moram no mesmo `PromptToAppRepository`, cujas leituras são
**síncronas e sem escopo**: `plans()`, `specs()`, `intakeTurns()`, `evidence()`.
Uma leitura com RLS é assíncrona e recebe o ator. Migrar um sem os outros
deixaria metade do repositório com uma forma e metade com outra — e um leitor
que não sabe qual metade está olhando é pior do que um repositório inteiro
antigo.

## O caminho, na ordem

O molde já existe e foi percorrido inteiro: `studio_integrations` saiu da
chave-valor em `plugins/integration-hub/src/tenant-repository.ts`, com fila
exclusiva por unidade e seleção por configuração (`storageAuthority`), falhando
alto quando a autoridade pedida não está disponível.

1. **Tornar assíncronas as cinco leituras**, ainda sobre a chave-valor. É a parte
   chata e é a que dá o passo seguro: nenhuma mudança de armazenamento, só a
   forma. Tudo que chama passa a esperar. O `tsc` encontra cada ponto.
2. **Repositório por inquilino**, no molde do `integration-hub`: tabela por
   domínio, `ENABLE`/`FORCE RLS`, credencial de runtime sem privilégio de
   contorno.
3. **Seletor por configuração**, padrão na chave-valor. Uma instalação existente
   não pode mudar de autoridade de armazenamento porque atualizou.
4. **Falsificação**: apagar a política e confirmar que o teste de vazamento entre
   inquilinos REPROVA. Um teste de RLS que passa com a política desligada não
   está testando a RLS — está testando o `if` do produto que continua lá.
5. **Subir o `RLS_MIGRATED_FLOOR`** a cada domínio migrado. É o piso que impede o
   número de cair depois.

## O que decide se vale a pena

O isolamento por código já existe nos cinco e é provado por teste. A RLS aqui é
**defesa em profundidade**: ela protege do dia em que alguém escrever uma
consulta nova e esquecer o `where`.

Isso é um ganho real e não é urgente — e a travessia mexe no caminho central do
produto (o pipeline lê plano, especificação e evidência o tempo todo). Feita com
pressa, ela quebra a criação de aplicativo, que é a única coisa que o produto faz.

**Recomendação: um passo por vez, com a suíte inteira entre cada um.** Começar
por `studio_intake_turns`, que é o de menor superfície: ele é escrito no intake e
lido na tela do projeto, e não participa da geração.

## O que NÃO está neste plano

Os outros 19. Eles não estão adiados — estão **excluídos**, com o motivo de cada
um citado no `gate:rls-coverage` e resumido na ADR-044. Três deles
(`studio_runs`, `studio_projects`, `studio_approvals`) voltam a ser candidatos
**se** a varredura de reinício for redesenhada para rodar por inquilino, o que
exige uma forma de enumerar inquilinos que hoje não existe.
