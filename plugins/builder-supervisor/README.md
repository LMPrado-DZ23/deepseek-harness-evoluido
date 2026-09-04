# DZ23 Builder Supervisor

Fronteira privilegiada do construtor isolado do DZ23 STUDIO. Este processo é
separado do Harness e é o único componente que pode acessar a API do Docker.
O socket do Docker nunca é montado no Harness.

## Contrato fechado

O cliente fala HTTP sobre um socket Unix `0660`, em `POST /v1/rpc`, usando um
bearer obtido por referência de segredo. As únicas operações são `preflight`,
`prepare`, `execute`, `cancel`, `finish` e `listManaged`. Todo corpo exige um
`request_id` novo; replay é recusado.

O cliente não escolhe imagem, comando, argumentos, usuário, rede, variáveis,
mounts, portas ou limites. `execute` aceita somente uma etapa da máquina fixa:

`install -> build -> unit -> e2e`

Cada contêiner usa a imagem fixada no supervisor, usuário `10001:10001`, rede
`none`, root filesystem somente leitura, `cap-drop ALL`,
`no-new-privileges`, limites de memória/CPU/PIDs/tempo e nenhum bind mount. O
artefato é verificado, empacotado sem links e copiado para volume nomeado antes
de qualquer execução. O workspace usa volume `tmpfs` com quota física e uma
âncora isolada; a concorrência total e por build é limitada no servidor.

Antes de abrir o socket, o supervisor adquire uma lease exclusiva, valida
proprietário, modo e inode, reconcilia contêineres e volumes rotulados e remove
órfãos. IDs recuperados continuam reservados e os `request_id` de produção são
gravados com criação exclusiva para continuarem inválidos após reinício.

Um build aprovado sai pela API de archive do Docker, em streaming com teto e
SHA-256. O tar é revalidado e extraído por descritores sem seguir links em um
staging novo, depois publicado por `rename`; nenhum diretório do host é montado
no contêiner. `finish` é idempotente e conserva `exported` e
`cleanup_pending` até o Docker confirmar que não restou recurso administrado.

## Integração

Este pacote é somente a fundação M6.2. A composição do processo, os segredos,
o volume imutável do store e o adaptador do Prompt-to-App pertencem à etapa de
integração. Não exponha este socket pela rede e não substitua os DTOs por
`argv`, shell ou configuração Docker recebida do cliente.
