# DZ23 Builder Supervisor

Fronteira privilegiada do construtor isolado do DZ23 STUDIO. Este processo é
separado do Harness e é o único componente que pode acessar a API do Docker.
O socket do Docker nunca é montado no Harness.

## Contrato fechado

O cliente fala HTTP sobre um socket Unix `0660`, em `POST /v1/rpc`, usando um
bearer obtido por referência de segredo. As únicas operações são `preflight`,
`prepare`, `execute`, `cancel`, `finish` e `listManaged`. Todo corpo exige um
`request_id`. Repetir exatamente o mesmo corpo devolve a resposta persistida;
reutilizar o ID com outro corpo é recusado.

O cliente não escolhe imagem, comando, argumentos, usuário, rede, variáveis,
mounts, portas ou limites. `execute` aceita somente uma etapa da máquina fixa:

`install -> build -> test -> e2e`

Cada contêiner usa a imagem fixada no supervisor, usuário `10001:10001`, rede
`none`, root filesystem somente leitura, `cap-drop ALL`,
`no-new-privileges`, limites de memória/CPU/PIDs/tempo e nenhum bind mount. O
artefato é verificado, empacotado sem links e copiado para volume nomeado antes
de qualquer execução. O workspace usa volume `tmpfs` com quota física e uma
âncora isolada; a concorrência total e por build é limitada no servidor.

Antes de abrir o socket, o supervisor adquire uma lease exclusiva, valida
proprietário, modo, inode, PID e identidade de início do processo; reconcilia
contêineres e volumes rotulados e remove órfãos. A reconciliação primeiro prova
a correspondência com o journal, recupera e publica qualquer build `E2E_OK` e
somente então remove seus recursos Docker; assim uma queda antes da exportação
não destrói o resultado recuperável. O replay durável é isolado por `scope_id`
+ `policy_sha256` dentro da raiz de estado persistente, conserva respostas
completas por 24 horas e
coleta somente resultados concluídos expirados. Claims de build ativos nunca
expiram; depois de concluídos permanecem reservados durante a mesma janela. O
journal liga de forma durável `build_id`, `build_ref`, estado, export e resultado
terminal. No reinício, o journal inteiro é validado antes de qualquer limpeza;
recursos Docker sem claim ou com identidade divergente são preservados como
evidência de recuperação e o boot falha fechado. Claim ativo sem recurso vira
resultado terminal e nunca autoriza repetir o build. A
retenção do próprio journal remove resultados antigos e libera a capacidade sem
depender de um mapa volátil em memória.

O preflight não confia apenas nas labels do store: monta o volume versionado
somente para leitura em um transporter efêmero isolado, baixa o envelope pela
Docker Archive API e reconstrói no host o mesmo manifesto canônico usado pelo
provisionador. PAX/GNU, links, devices, FIFO, duplicidade, traversal, limites
excedidos, marker ausente ou hash diferente são recusados antes de atestar
`state: OK`.

O materializador M6.3 copia o envelope selado `<version>/{tree,.complete}` para
um volume determinístico de `installation_id + scope_id + versão + hash`.
Produtores de `TemplateStoreManifest` devem validar cada entrada com
`templateStoreUstarEntryPath`; caminhos aceitos pela gramática lógica mas que
não cabem no `name`/`prefix` USTAR são recusados antes do acesso ao Docker.
Adquire antes um claim-contêiner com nonce e TTL, prova o volume vazio, envia a
árvore em tar determinístico e o `.complete` em um segundo upload, sempre por
último. A imagem builder fixada é o único transporter; seu comando `node -e` é
fixo, sem shell, rede, bind ou portas, autoexpira acima do deadline da operação
e é removido automaticamente; o claim permanece como witness. O volume é
somente leitura nos builds.
Uma corrida nunca autoriza apagar um volume sem o nonce da tentativa; uma queda
só é recuperada depois que o claim autoexpira e está `created` (queda entre a
criação e o start), `exited` ou `dead`. Claims `running`, `restarting`,
`paused` ou `removing` continuam ocupados e nunca são tomados. O preflight usa
o mesmo claim, portanto também não deixa transporter órfão na janela entre
criação e start; `BUSY` resulta apenas em volume inelegível.

Um build aprovado sai pela API de archive do Docker, em streaming com teto e
SHA-256, diretamente para um descritor criado pelo supervisor. Raiz, diretório
pai, inode, device, tamanho e digest são revalidados antes da publicação. O tar é
extraído sem seguir links em um staging novo; arquivos, manifesto e diretórios
internos são sincronizados bottom-up antes da publicação por `rename`;
nenhum diretório do host é montado no contêiner. Somente `.next/standalone`,
`.next/static`, `public` e o relatório de aceite podem sair. Archives temporários,
staging e quarentenas `.orphan-*` são recursos gerenciados, sincronizados e
coletados no boot e antes de nova exportação. Retenção por contagem e quota global
é aplicada antes de confirmar o resultado. Publicações de journals ainda ativos
ficam pinadas e nunca são removidas pela retenção; só depois do commit durável do
journal tornam-se elegíveis à evicção. `finish` é linearizado por
`build_ref`: concorrentes recebem o mesmo resultado ou erro, e `exported` mais
`cleanup_pending` permanecem duráveis até zero recurso administrado.

## Integração

Este pacote é somente a fundação M6.2. O entrypoint `builder-supervisor` compõe
o adaptador Docker, o journal durável, a reconciliação de boot, o replay RPC e o
socket Unix, mas **não é ativado por este pacote**. Compose, imagem, criação dos
arquivos protegidos e adaptação do Prompt-to-App pertencem a etapas separadas.
Não exponha este socket pela rede e não substitua os DTOs por `argv`, shell ou
configuração Docker recebida do cliente.

O processo aceita somente `--config file:/caminho/absoluto`. Não consulta
variáveis de ambiente para configuração, token ou digests. Em produção, o
arquivo deve existir exatamente em
`/etc/dz23-studio/builder/instances/<scope_id>/supervisor.json`, pertencer a root
ou ao UID do processo, ser regular, não ser link, ter um único hard link e não
ser gravável por grupo/outros. Token e digests são lidos de referências `file:`
exatas sob as raízes fechadas. O bearer aceita somente modo `0400` ou `0600`,
sem qualquer permissão para grupo/outros. Erros e códigos de saída nunca incluem
caminhos, conteúdo ou segredos.

### Manager multi-runtime M6.3

O entrypoint opcional `lib/start-builder-manager.js` (script `start:manager`) aceita somente
`--registry file:/etc/dz23-studio/builder/manager/runtime-registry.json`. Ele
mantém um runtime independente por `scope_id`, cada qual carregado pela mesma
validação single-runtime, com token, socket, artefatos, exports, journal e replay
próprios. O registry é uma allowlist autoritativa; o manager nunca descobre
configurações percorrendo diretórios.

O campo externo `config_sha256` fixa o envelope imutável v1, calculado com
framing de nome+tamanho+bytes crus sobre `supervisor.json`, o digest da imagem,
o digest do template store e o digest da política. O token fica fora desse
envelope para permitir rotação. O loader consome exatamente os descritores que
foram hasheados, eliminando troca de arquivo entre verificação e uso.

Reload por `SIGHUP` ou polling exige geração monotônica e conteúdo integralmente
válido. Um scope removido entra em `RETIRING`, para de aceitar RPC e drena com
prazo. Falha de um scope não encerra os demais. Health persistente usa somente
o `scope_id`, estado verdadeiro, timestamps e códigos fechados. O scheduler de
capacidade global é justo por scope e limita as filas; a lease cobre o build de
`prepare` até estado terminal, cancelamento concluído, finalização comprovadamente
limpa ou encerramento.

Antes de aplicar a primeira geração, uma lease de processo por `installation_id`
é mantida por `flock` em guard permanente privado sob `stateRoot`. Um checkpoint
atômico e sincronizado é publicado antes dos efeitos de cada nova geração e
preserva anti-rollback e imutabilidade de configuração entre restarts. O backend
de arquivo exige Linux em ext4 ou XFS; implementações em memória existem somente
para testes.

O manager é fundação e não é ativado automaticamente, não cria os arquivos de
autoridade e não concede isolamento de processo. O contrato e as restrições de
rollout estão em `ADR-034`.

O JSON é um contrato fechado, sem chaves extras:

```json
{
  "version": 1,
  "installation_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "tenant_id": "tenant-one",
  "instance_id": "instance-one",
  "socket_path": "/run/dz23-studio/builder/instances/s_10d6067021ca707c6acab1260770dd26ea90a1e8e6d1bc1b/rpc.sock",
  "artifact_root": "/srv/dz23-studio/generated-runs/instances/s_10d6067021ca707c6acab1260770dd26ea90a1e8e6d1bc1b",
  "export_root": "/srv/dz23-studio/builder-exports/instances/s_10d6067021ca707c6acab1260770dd26ea90a1e8e6d1bc1b",
  "journal_root": "/var/lib/dz23-studio/builder/instances/s_10d6067021ca707c6acab1260770dd26ea90a1e8e6d1bc1b/journal",
  "replay_root": "/var/lib/dz23-studio/builder/instances/s_10d6067021ca707c6acab1260770dd26ea90a1e8e6d1bc1b/rpc-replay",
  "docker_socket_path": "/var/run/docker.sock",
  "bearer_token_ref": "file:/run/secrets/dz23-studio/builder/instances/s_10d6067021ca707c6acab1260770dd26ea90a1e8e6d1bc1b/token",
  "image_digest_ref": "file:/etc/dz23-studio/builder/instances/s_10d6067021ca707c6acab1260770dd26ea90a1e8e6d1bc1b/builder-image.sha256",
  "template_store_version": "v1.0.0",
  "template_store_sha256_ref": "file:/etc/dz23-studio/builder/instances/s_10d6067021ca707c6acab1260770dd26ea90a1e8e6d1bc1b/template-store.sha256",
  "policy_sha256_ref": "file:/etc/dz23-studio/builder/instances/s_10d6067021ca707c6acab1260770dd26ea90a1e8e6d1bc1b/policy.sha256"
}
```

`SIGINT` e `SIGTERM` primeiro verificam a autoridade do socket, depois abortam
as operações cooperativas e aguardam a drenagem/limpeza limitada. Um segundo
sinal encerra conexões restantes. Se o pathname já pertence a outro processo,
o supervisor não o renomeia, remove nem fecha: desconecta e remove a referência
do seu próprio listener, que já está inacessível pelo pathname, e sai com falha.
A remoção do socket e da lease sempre revalida identidade e nunca remove ou
sobrescreve um socket substituído por outro processo.

A composição de produção deve fornecer obrigatoriamente um `FileBuildIdGuard`;
um guard em memória é permitido somente em testes e não protege o `build_id`
contra replay depois de reinício do supervisor.

### Provisionamento local imutável

`builder-provision` é a fundação local e explícita que prepara **uma** instância
de tenant. Ela não inicia o supervisor, não acessa Docker e não altera Compose ou
o Prompt-to-App. O comando recebe somente identificadores, caminhos e digests
públicos; o bearer é gerado dentro do processo e nunca vem de argumento,
variável de ambiente ou log.

A fonte é um diretório Linux privado fora das raízes administradas e um
manifesto JSON separado, fixado pelo SHA-256 do próprio manifesto. O manifesto
v1 contém `template_store_version`, `tree_sha256` e uma lista fechada de
diretórios/arquivos com tamanho e SHA-256. Caminhos aceitam somente ASCII seguro,
não admitem colisões por caixa, links, hardlinks, FIFO, devices ou escapes. O
store é copiado por descritores com `O_NOFOLLOW`, conferido novamente, sincronizado
e selado em `0555`/`0444`. O diretório da versão é reservado por `mkdir` exclusivo;
a árvore entra no envelope como `tree`, o marcador `.complete` é persistido e o
envelope só então muda atomicamente de `0700` para o estado publicado `0555`.
Leitores só podem considerar visível um envelope `0555` com marcador e árvore
integralmente validados. Um store já publicado nunca é sobrescrito: igualdade permite concluir a
recuperação da configuração; qualquer divergência falha fechada.

Stagings interrompidos e arquivos de autoridade parciais são recuperados somente
depois de adquirir o lock. O lock não expira por relógio: um reclaim exige que
`boot_id`, PID e start ticks do proprietário não correspondam mais ao processo.
`supervisor.json` é publicado por último, depois do token `0400` e dos digests
`0600`, todos sob as raízes exatas de `BuilderSupervisorRootPolicy`.

Todas as mudanças em `.provision.lock`, claims e testemunhos de takeover são
serializadas pelo arquivo permanente `.provision.guard`. O instalador o cria em
`0600` dentro da raiz `0700`; depois que existir qualquer estado, o runtime nunca
o remove, renomeia ou recria. O processo abre esse arquivo com `O_NOFOLLOW`,
revalida dono, modo, inode e link count e passa somente o descritor para
`/usr/bin/flock --exclusive --nonblock --conflict-exit-code 200 3`, sem shell,
com argumentos fixos e ambiente vazio. O descritor permanece aberto durante a
seção crítica curta, por isso o kernel libera a trava inclusive após `SIGKILL`.
A cópia e o hash do store ficam fora da trava; os testemunhos duráveis só são
limpos depois que store e configuração terminam. O suporte desta fatia é
deliberadamente restrito a Linux sobre ext4 ou XFS; `/mnt/*`, NFS, CIFS, FUSE,
btrfs e Windows falham fechados. Processos com o mesmo UID fazem parte da TCB
local, pois podem substituir pathnames dentro da raiz privada.

As raízes por instância são `0700` e estabelecem o mesmo UID do provisionador
como fronteira administrativa: outro processo com esse UID já poderia remover
qualquer store ou segredo, portanto não é tratado como ator não confiável. Entre
provisionadores cooperativos, o lock impede a corrida; arquivos finais usam
hardlink temporário como publicação `no-replace`, e o recovery reduz novamente
o link count para um se houver queda entre link e unlink. O diretório versionado
também é `no-replace`: `mkdir` reivindica o pathname final antes que qualquer
rename ocorra. Um alvo vencido por outro processo é apenas verificado e jamais
removido ou substituído. A recuperação de envelope incompleto só é autorizada
quando o lock anterior foi comprovadamente recuperado por `boot_id`, PID e start
ticks, nunca por tempo ou pela mera aparência do diretório.

Depois do build do pacote, em Linux:

```sh
node lib/provision-cli.js \
  --installation-id <sha256-da-instalacao> \
  --tenant tenant-one \
  --instance instance-one \
  --source-root /opt/dz23/templates/v1 \
  --manifest file:/opt/dz23/manifests/v1.json \
  --manifest-sha256 <sha256-do-manifesto> \
  --image-digest sha256:<digest-da-imagem> \
  --policy-sha256 <sha256-da-politica>
```

O instalador futuro deve criar previamente as raízes da policy com dono e modos
seguros. Esta fatia não provisiona volume Docker nem torna o serviço ativo.

### Template store materializado (M6.3)

O volume físico contém `tree/**` e `.complete`. O passo de instalação monta a
raiz em `/template-store` como read-only e usa exclusivamente
`--store-dir /template-store/tree`. A raiz é uma fronteira gerida pelo driver
Docker: o parser exige uma única entrada diretório, mas não usa UID/GID ou modo
da raiz como atestação. `tree`, seus descendentes e `.complete` permanecem
estritos (UID/GID 10001; diretórios 0555; arquivos 0444), com manifesto e hash
canônicos.

O verifier tem deadline próprio de 8 minutos mais orçamento conservador de até
2 minutos para cleanup, ambos dentro do TTL de 15 minutos do claim. A liberação
revalida a geração do claim, ausência do transporter e nonce estável do volume.
Docker real está desligado neste checkpoint: Archive API, comportamento de
metadata entre drivers e instalação offline real permanecem `NOT_EXECUTED`.

### Isolamento de organização/tenant

O protocolo v1 não recebe nem devolve `org_id`, `tenant_id` ou `instance_id`.
A integração deve iniciar uma instância exclusiva por escopo físico, com
`scope_id`, bearer secret, socket, raiz de artefatos, raiz de exports, journal e
replay exclusivos. Reutilizar qualquer uma dessas credenciais ou raízes entre
tenants é configuração inválida para produção. O `scope_id` opaco é derivado no
servidor, com domínio e versão, a partir de `installation_id`, `tenant_id` e
`instance_id`. Ele é a única identidade operacional usada em nomes, labels,
filtros, attestation e replay. Os identificadores lógicos não entram no
protocolo nem nas labels do Docker. Essa separação evita colisões, mas a
integração não pode anunciar isolamento multi-tenant até provar a composição
ponta a ponta.

O deadline RPC padrão é 240 s, cobrindo o teto de etapa de 180 s e a janela de
cleanup de 30 s. Configurações customizadas são recusadas quando o deadline RPC
é menor que `stepTimeoutMs + cleanupTimeoutMs`. Timeout, desconexão do cliente e
shutdown são causas distintas e respostas abortadas não são persistidas no replay.

### Cliente Unix M6.2

`createBuilderUnixClient` é a fundação tipada do lado não privilegiado. O
chamador entrega o caminho absoluto do socket, uma referência `file:/...` e um
resolvedor de credenciais; o cliente não consulta ambiente, arquivo, Docker ou
configuração de tenant por conta própria. Cada método recebe o DTO completo com
`request_id` já escolhido pelo chamador. Não existe geração de ID nem retry
automático: uma repetição deliberada deve reutilizar o mesmo DTO para acionar o
replay idempotente do servidor.

O transporte limita o pedido a 64 KiB, a resposta a no máximo 4 MiB e a chamada
a no máximo 600 s (240 s por padrão). Deadline e `AbortSignal` também limitam a
resolução do segredo. Status, `Content-Type`, `Content-Length`, UTF-8, envelope,
código de erro e DTO de sucesso são validados por allowlist antes de retornar ao
chamador. A fundação não ativa o supervisor, não seleciona tenant, não monta o
socket e não concede qualquer autoridade Docker.

O limite de 64 KiB do pedido é defesa em profundidade e só pode ser reduzido
pelo chamador: o esquema fechado atual limita os DTOs a aproximadamente 800
bytes. A referência `file:/...` é validada somente quanto à sintaxe e ao teto
de 4 KiB; o cliente não abre o arquivo. O
resolvedor de produção ainda deve provar arquivo regular, `O_NOFOLLOW`, um único
link, proprietário e modo esperados e recusar dispositivos, FIFO e links. O
classificador exportado separa `BLOCKED_EXTERNAL`, falha do build, cancelamento e
erro interno, mas permanece sem call site nesta fundação.
