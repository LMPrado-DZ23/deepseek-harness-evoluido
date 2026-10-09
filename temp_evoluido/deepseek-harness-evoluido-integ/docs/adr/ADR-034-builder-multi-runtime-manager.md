# ADR-034 — Manager multi-runtime do Builder Supervisor

- Estado: Aceita
- Data: 2026-09-05
- Ressalva: para a fundacao M6.3
- Numero compartilhado com: ADR-034-template-store-volume-materialization

## Contexto

O processo single-runtime da M6.2 prova uma fronteira privilegiada por escopo,
mas uma instalação precisa operar vários escopos sem compartilhar token,
socket, journal, replay ou configuração. Descobrir arquivos recursivamente
transformaria qualquer arquivo plantado no disco em autoridade. Reiniciar todo
o processo para cada alteração também derrubaria escopos não relacionados.

## Decisão

Um único manager por instalação lê somente o arquivo autoritativo exato
`<configRoot>/manager/runtime-registry.json`. O arquivo é aberto com
`O_NOFOLLOW` e validado por tipo, inode, hardlinks, dono, modo, tamanho,
`realpath` e UTF-8 fatal. O schema v1 é fechado:

```json
{
  "version": 1,
  "installation_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "generation": 1,
  "slots": [{
    "scope_id": "s_111111111111111111111111111111111111111111111111",
    "config_ref": "file:/etc/dz23-studio/builder/instances/s_111111111111111111111111111111111111111111111111/supervisor.json",
    "config_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "state": "active"
  }]
}
```

`installation_id` e `scope_id` são identidades físicas. Nenhum `org_id`,
`tenant_id`, `instance_id`, `build_id`, token ou segredo aparece no registry,
health ou log do manager. Cada referência aponta exatamente para a configuração
do próprio `scope_id`. Apesar do nome externo preservado por compatibilidade,
`config_sha256` é o digest versionado do envelope imutável: framing canônico
`dz23-builder-config-envelope-v1`, seguido pelo nome, tamanho e bytes crus de
`supervisor.json`, `builder-image.sha256`, `template-store.sha256` e
`policy.sha256`. O token não participa do digest e pode ser rotacionado. Cada
arquivo é lido uma vez por descritor seguro; os mesmos bytes validados são os
bytes consumidos pela composição, sem ciclo verificar-fechar-reabrir. A
configuração de um scope é imutável durante a vida da instalação, inclusive
após restart. Trocar qualquer arquivo do envelope, referência ou digest para o
mesmo scope recusa o reload inteiro; rollout de configuração usa um novo scope.
O framing v1 fixa apenas a referência de integridade atual do template store;
ele ainda não inclui o JSON canônico do manifest durável. A integração futura
com o materializador deve persistir esse manifest e introduzir um framing v2,
sem reinterpretar digests v1 existentes.

Antes de iniciar ou retirar qualquer slot, o manager toma uma lease exclusiva
por `installation_id`. O guard permanente fica em diretório privado sob
`stateRoot`, é aberto com `O_NOFOLLOW`, validado por dono/inode/nlink/modo e
mantém um `flock` no descritor pela vida inteira do processo. Só ext4 e XFS são
aceitos. Um segundo manager falha no startup; morte por `SIGKILL` libera a
lease pelo kernel sem apagar nem recriar o guard.

Sob essa lease, o manager carrega um checkpoint v1 fechado com
`installation_id`, geração, hash do registry e a lista histórica de
`scope_id`/referência/hash de configuração. O checkpoint é publicado antes dos
efeitos da geração, por arquivo temporário `0600`, `fsync`, `rename` e `fsync`
do diretório. Assim, restart não permite rollback, conteúdo diferente na mesma
geração nem reintrodução de um scope com configuração alterada. Um crash depois
do checkpoint permite repetir idempotentemente a mesma geração. O histórico é
limitado a 512 scopes físicos por instalação; depois disso, uma nova instalação
física é necessária.

Gerações são monotônicas. Mesma geração e mesmo hash é uma releitura idempotente
e permite tentar novamente um slot antes indisponível. Mesma geração com outro
conteúdo ou geração anterior falha sem mudar os slots. O registry inteiro é
validado antes de qualquer efeito; há no máximo 512 slots e nenhuma duplicata
de scope ou referência.

`SIGHUP` e polling pedem reload pelo mesmo coalescer. O callback de polling não
bloqueia o event loop, há deadline de leitura/start e rajadas conservam no
máximo uma releitura pendente. Uma falha de start afeta somente seu scope e vira
`DEGRADED` ou `BLOCKED_EXTERNAL`; os demais continuam. Um slot removido ou
marcado `retiring` fecha o listener primeiro, drena operações com prazo e depois
aborta conexões restantes. Shutdown aplica a mesma regra a todos os slots.

Health é persistido por scope em arquivo atômico sincronizado, contendo apenas
`STARTING`, `HEALTHY`, `DEGRADED`, `RETIRING`, `STOPPED` ou
`BLOCKED_EXTERNAL`, timestamps e código fechado. Mensagens de exceção nunca são
persistidas nem registradas.

A capacidade global é um semáforo limitado e justo por scope. A lease nasce em
`prepare`, fica associada ao `build_ref` e é liberada em estado terminal,
`cancel` comprovadamente concluído, `finish` comprovadamente limpo, falha de
preparação ou encerramento do runtime. Falha ou cleanup incompleto conserva a
lease. As filas
global e por scope têm limites explícitos; isso não altera nem expõe opções do
Docker.

## Consequências e limites

O manager compartilha processo e autoridade Docker; ele é parte da TCB e não é
isolamento de processo entre tenants. O isolamento operacional vem das
configurações, credenciais, caminhos e escopos separados. A troca de arquivo por
um ator com o mesmo UID do manager continua fora da fronteira de ameaça; em
produção os arquivos devem pertencer a root e o processo deve usar UID dedicado.

Esta fatia não cria registry/configs, não monta Docker/Compose/Caddy, não
materializa template store e não adapta o Prompt-to-App. Esses trabalhos só
podem consumir o contrato depois dos gates desta fundação.

## Evidência exigida

- dois scopes ativos sem cruzamento de configuração ou lifecycle;
- rejeição de registry malicioso, linkado, fora do caminho, duplicado ou em
  rollback;
- config imutável e reload inválido sem alteração parcial;
- falha e retirada de um scope sem derrubar outro;
- storm de `SIGHUP` coalescida, polling não bloqueante e start tardio coletado;
- capacidade global justa e limitada, sem lease de build órfã;
- lease de processo multiprocesso, liberação por `SIGKILL` e checkpoint
  anti-rollback/configuração imutável entre restarts;
- health durável e sanitizado; nenhum segredo ou identidade lógica em saída.
