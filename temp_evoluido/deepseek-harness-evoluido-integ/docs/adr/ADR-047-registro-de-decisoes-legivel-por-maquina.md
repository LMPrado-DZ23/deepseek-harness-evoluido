# ADR-047 — O registro de decisões passou a ser legível por máquina

- Estado: Aceita
- Data: 2026-09-12
- Ressalva: os números duplicados continuam duplicados, por decisão registrada abaixo; a identidade passou a ser o nome do arquivo
- Autor: Claude (Opus 5), dentro da autonomia delegada por Prado ("continua até terminar todo o projeto")
- Tarefa correspondente: `T-26` (memória de decisão)

<!-- Esta ADR escreve os numeros ambiguos DE PROPOSITO, porque e sobre eles que
     ela fala: citacao-ambigua-proposital -->

## Contexto

Este projeto tem cinquenta ADRs. Elas são o único lugar onde está escrito o que
foi decidido e por quê — e nada as lia.

O estado de cada decisão aparecia em **seis sintaxes diferentes**: `- Status:`,
`Status:`, `**Status:**`, `## Status`, `## Estado`, e `Data: … Estado: … Autor:
…` na mesma linha. O valor era prosa livre: "Aceito", "aceita e implementada no
bloco 5 da fatia 2", "fundação BETA, ainda não ligada aos domínios de produto",
"substituído pelo ADR-022". Nenhuma dessas formas é consultável.

Pior: o **número deixou de identificar**. `ADR-038` nomeia três decisões
distintas (reconciliação de agentes em M75, fronteira multiusuário do assistente
em M73, núcleo de staging imutável em M89); `ADR-034` nomeia duas; `ADR-039`
nomeia duas.

E havia **sete citações vivas** apontando para um número compartilhado — em
`docs/CAPABILITY_MATRIX.md`, no livro mestre de requisitos, no perfil
`cordis.patch.yml` que MONTA o plugin de aprovação, no README do
builder-supervisor, no comentário de `plugins/staging/src/repository.ts` e
dentro de duas ADRs. Quem seguisse qualquer uma chegava a uma pasta com três
respostas e nenhuma forma de saber qual era a certa.

Havia também um elo de substituição **de uma perna só**: a ADR-019 dizia
"substituído pelo ADR-022", e a ADR-022 não dizia nada de volta. Quem chegasse
pela ADR-022 não tinha como saber que estava lendo a decisão vigente, nem que
existia uma anterior preservada de propósito como fallback.

Uma decisão que não se consegue citar não está registrada.

## Decisão

Toda ADR passa a ter um cabeçalho fechado, em bullets, logo abaixo do título:

```text
- Estado: Aceita | Substituída | Proposta | Rejeitada
- Data: AAAA-MM-DD
- Ressalva: <o que a declaração dizia ALÉM do estado>   (quando houver)
- Substituida por: <slug>                                (quando Substituída)
- Substitui: <slug>                                      (do outro lado do elo)
- Numero compartilhado com: <slug>[, <slug>]             (quando o número é ambíguo)
```

`Ressalva` é obrigatória sempre que a declaração original dizia mais que o
estado, e ela guarda o texto **como foi escrito**. É ali que mora a honestidade
do registro — "aceita com limitação explícita", "pendente de confirmação
jurídica do Prado", "Docker real continua `NOT_EXECUTED` neste checkpoint" —, e
achatar isso num `Aceita` limpo seria trocar registro por aparência.

`Rejeitada` existe na lista fechada mesmo sem nenhuma ADR usando-a hoje: apagar
uma recusa faz a mesma proposta voltar daqui a três meses sem ninguém lembrar do
motivo.

A **identidade de uma decisão é o nome do arquivo** (`ADR-038-immutable-staging-core`),
que é único por construção do sistema de arquivos. O número continua sendo
rótulo humano.

`scripts/decision-record.mjs` lê isso tudo e oferece `resolveCitation`, que
recusa resolver um número compartilhado em vez de devolver "a primeira" — quem
chamasse receberia uma decisão de verdade, com texto plausível, e não teria como
saber que era a errada.

`scripts/check-decision-record.mjs` é o portão (`pnpm gate:decision-record`), com
trinta e dois auto-testes, e recusa: cabeçalho ausente ou fora do padrão, estado
fora da lista fechada, data em prosa, número do título divergente do arquivo,
substituição apontando para decisão inexistente, elo de uma perna só, número
compartilhado não declarado dos dois lados, e **citação ambígua em qualquer
arquivo rastreado**.

## O que NÃO foi feito, e por quê

**Os números duplicados não foram renumerados.** Renumerar é a solução óbvia e
seria a mais limpa em um repositório novo. Aqui ela reescreve o identificador
pelo qual Prado se refere a estas decisões fora deste repositório — em conversa,
em anotação, em prompt de executor —, e o ganho é estético: o defeito real é uma
citação que não resolve, e isso fecha inteiro exigindo que a citação nomeie o
arquivo. A ADR que compartilha número agora DECLARA com quem o compartilha, o
que torna a colisão visível em vez de silenciosa.

Renumerar continua disponível e é decisão do Prado. O portão não fica mais fraco
por causa disso: ele já recusa toda citação ambígua nova.

**A varredura de citação tem uma saída explícita, e ela é contada.** Alguns
arquivos escrevem `ADR-038` para falar DA ambiguidade, e não para citar uma
decisão: os auto-testes deste portão provam que esse número não resolve — e não
há como provar isso sem escrevê-lo —, esta ADR explica o defeito nomeando os
três números, e o livro mestre registra o achado. Um arquivo que contenha a
marca `citacao-ambigua-proposital` fica de fora da varredura, e o veredito
imprime `saidas_explicitas=N`: uma saída silenciosa viraria o buraco por onde
toda citação quebrada futura passaria despercebida.

A primeira versão trazia, no lugar dessa marca, uma lista fixa com os dois
arquivos do próprio portão. Ela reprovou no mesmo dia — contra esta ADR e contra
o livro mestre, escritos por este mesmo trabalho —, que é exatamente o caso que
uma lista fixa não previa. `audit/` continua fora por prefixo, porque um
relatório de auditoria inteiro existe para descrever achados.

## Consequência

Uma ADR nova que esqueça o cabeçalho reprova o portão. Uma citação nova a um
número compartilhado reprova o portão. Uma substituição registrada em um lado só
reprova o portão.

O que isto **não** garante: que a `Ressalva` esteja correta, ou que o estado
declarado corresponda ao que o código faz. Nenhum portão consegue conferir isso,
e dizer o contrário seria vender verificação onde há convenção. O que ele
garante é que a decisão possa ser encontrada, citada sem ambiguidade e lida por
algo que não seja uma pessoa.
