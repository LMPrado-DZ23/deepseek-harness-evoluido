# ADR-048 — As missões saíram da chave-valor opaca para a tabela com isolamento por linha

- Estado: Aceita
- Data: 2026-09-12
- Autor: Claude (Opus 5), dentro da autonomia delegada por Prado ("continua até terminar todo o projeto")
- Requisito correspondente: `OS-49`
- Tarefa correspondente: `T-32` (isolamento no banco)
- Decisão relacionada: [ADR-044](ADR-044-alvo-alcancavel-de-rls.md), que classificou `studio_missions` como `ready`

## Contexto

A auditoria de `S-08` classificou vinte e sete domínios por quão longe estavam
de sair da chave-valor opaca. `studio_missions` foi o único classificado
`ready`: toda leitura dele passa por (organização, inquilino, identificador),
não há varredura de início, não há guarda síncrona e não há invariante entre
inquilinos. A classificação era uma promessa — e uma promessa que ninguém
cumpre é indistinguível de uma desculpa.

Havia um segundo motivo, mais urgente. `OS-46` fechou a janela de
leitura-alteração-gravação do motor de missão com uma **fila em memória**, e a
limitação estava declarada no próprio registro: *"a fila fecha a janela DENTRO
do processo; entre processos ela continua aberta"*. `OS-48` trouxe a gravação
condicional durável (`putIf`) para o armazenamento por inquilino, e o próximo
passo registrado ali era exatamente este: levá-la à missão.

## Decisão

As missões passam a ter **duas** autoridades possíveis, escolhidas por
configuração (`storageAuthority`), com `kv` como padrão:

- `kv` — a tabela chave-valor do seam de domínio, como antes.
- `rls` — a tabela por inquilino, onde a organização e o inquilino viajam na
  própria consulta e a separação é do banco, não de um `if` do processo.

O registro ganhou um campo `revision`: um inteiro que começa em zero e sobe de
um a cada gravação. Quem grava declara a revisão que **leu**; se o registro
andou nesse meio-tempo, a escrita não acontece e a chamada recusa com frase de
catálogo em vez de passar por cima do trabalho alheio.

`updated_at` não serviria como testemunho: duas gravações no mesmo milissegundo
produzem o mesmo carimbo, e uma condição que passa por empate de relógio não é
condição.

## Consequências

- `MissionRepository` ficou assíncrono e passou a receber o escopo na leitura.
  O serviço, a porta de teto e as seis rotas acompanharam.
- Pedir `rls` sem o armazenamento por inquilino montado **falha alto**. Cair de
  volta para a chave-valor em silêncio seria o pior desfecho: quem pediu
  isolamento no banco acharia que o tem.
- Trocar a chave **não copia nada**. `studio_missions` é novo e ainda não tem
  dado de ninguém, então aqui a troca é barata — mas dizer isso e deixar a troca
  migrar dados em silêncio são coisas diferentes, e esta é a segunda.
- `putIf` continua **opcional no tipo** (`putIf?`). O armazenamento que não o
  oferece volta ao caminho de duas idas, suficiente em instância única sob a
  fila e insuficiente com réplicas — e essa diferença está dita, não escondida.
- A fila em memória **continua existindo** e continua útil: ela evita ida ao
  banco no caso comum. O que ela deixou de ser é a única defesa.

## Limitação declarada

Nenhuma réplica real foi executada. A prova entre processos é a de `OS-48`:
dois armazenamentos com conexões separadas contra o mesmo PostgreSQL, que é o
que duas réplicas são do ponto de vista do banco — mas não exercita eleição,
partição de rede nem reinício no meio.

A conferência de escopo **dentro do corpo do registro** continua na leitura,
mesmo com o banco separando por linha: se um dia uma linha for gravada com o
escopo errado no corpo, ela some da leitura em vez de aparecer como se fosse de
quem perguntou.
