# M97 — D-02 e E-01: o staging saiu do papel

## O que se afirma

O staging está **montado no perfil real**, publica um artefato verificado num
destino local com efeito conferível, e o elo **Prévia → Staging** — o último
buraco da jornada E-01 — existe.

```
"staging": { "state": "MOUNTED", "target": "dz23-target:staging-local" }
```

(`node scripts/prove-assistant-session-runtime.mjs`)

## Por que isso não podia existir antes

O `StagingArtifact` exige **dez** campos: hash do artefato, do manifesto, da
aceitação, do SBOM, da proveniência, a imagem do construtor e a política. O
Studio produzia **um**. Preencher os outros nove seria fabricar atestação — e
atestação fabricada *autoriza*.

Encadeado a isso, o caminho de sucesso do pipeline lançava exceção (M96), então
não havia execução aprovada nenhuma para publicar. Resolvido E-05, os dez campos
são reais e a ponte pôde ser escrita honestamente.

## As quatro peças

**Origem** (`source.ts`) — só vira artefato publicável uma execução aprovada,
com integridade de template **verificada de novo aqui** (o que vai para staging
tem efeito fora do Studio, e um registro antigo não pode passar por
"conferido"), e com as dez atestações. Cada recusa tem código próprio porque
pedem gestos diferentes: gerar de novo, rodar numa versão que produza
atestações, ou tratar um problema de segurança. Uma execução **nomeada** que não
existe no escopo não vira outra.

**Journal** (`repository.ts`) — as cinco garantias atômicas do port sobre o seam
real. O estado do destino é **derivado do journal**, não de uma segunda tabela:
bastaria uma escrita chegar e a outra não para a geração dizer 7 enquanto o
journal mostra 8. Três testes de reinício provam o que isso compra. Grava no
disco antes da memória — com teste que faz o disco recusar.

**Provedor** (`local-provider.ts`) — o efeito é real:

1. **Confere antes de publicar.** Cada arquivo contra o manifesto atestado.
   Arquivo trocado, arquivo a mais, arquivo faltando e link simbólico reprovam,
   e a recusa é definitiva e **sem efeito**. É entre a verificação e a
   publicação que uma troca passaria despercebida.
2. **Publica por renomeação.** A geração é montada num diretório temporário e só
   então renomeada. Copiar direto deixaria meia aplicação publicada e servindo
   se a máquina caísse no meio.
3. **É idempotente pela chave do pedido.** Repetir devolve o mesmo recibo sem
   copiar de novo — é isso que permite perguntar "aconteceu?" depois de uma
   resposta perdida. Sem publicação, a resposta é `UNKNOWN`, nunca "não
   aconteceu": um "não" falso liberaria uma segunda publicação por cima de um
   efeito em voo.

**Rota** (`http.ts`) — extensão do prompt-to-app, sem segunda autoridade sobre
`/api/studio/apps`. Contrato por rota; publicar exige `project.publish_staging`,
ler exige `project.read`. **Não existe rota de apagar**: apagar o registro não
desfaz o efeito — desfazer é `rollback`, que publica uma geração *nova* com o
artefato anterior.

## Provas

`plugins/staging`: **91 testes**. **30 mutações, 30 mortas** (16 do journal e da
origem, 14 do provedor), depois de duas rodadas que encontraram lacunas reais.

O que as duas rodadas encontraram, e que é o motivo de mutar:

- **fencing do lease no CAS**: o primeiro teste não isolava o lease — o release
  já estava concluído e era recusado por outro motivo. O teste foi reescrito com
  um release realmente em voo.
- **ordem disco/memória**: nenhum teste distinguia. Agora o disco recusa e o
  teste exige que a memória não enxergue.
- **`Math.max` redundante**: a ordenação anterior já garantia. O código foi
  **removido**, e a mutação passou a atacar a ordenação — que é quem de fato
  garante.
- **geração absurda**: a guarda existia só na leitura, onde era inalcançável.
  Passou a valer na **escrita**, onde uma geração absurda criaria um diretório
  de lixo dentro da raiz de staging.

## Decisão registrada: o destino é LOCAL

Staging na v1.0 publica numa pasta do próprio computador, dentro de `$DSH_HOME`
— que já é onde o produto escreve tudo. Um destino em rede exige credencial,
domínio e autorização que o produto não tem, e **um provedor que fingisse
publicar seria pior que a ausência dele**. Exigir configuração explícita da
pasta deixaria a jornada quebrada por padrão sem ganho de segurança nenhum.

## Limites declarados

- Destino em rede está **fora da v1.0**.
- As atestações não são assinadas (ver E-05); hash é integridade, não origem.
- As garantias atômicas valem porque o Studio é **escritor único** da unidade.
  Não é transação distribuída e não vira ativo-ativo.
- **Não há tela.** Publicar e desfazer são por rota.
- E-01 continua sem uma prova de ponta a ponta com um brief leigo real
  atravessando os oito passos: cada elo tem prova própria, a emenda entre eles
  não.
