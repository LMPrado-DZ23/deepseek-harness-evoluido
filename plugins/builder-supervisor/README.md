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
não destrói o resultado recuperável. O replay durável é isolado pelo
triplo `scope_id` + `instance_id` + `policy_sha256`, conserva respostas completas por 24 horas e
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
somente para leitura em um verificador efêmero isolado, calcula a árvore real e
exige o SHA-256 configurado antes de atestar `state: OK`.

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

Este pacote é somente a fundação M6.2. A composição do processo, os segredos,
o volume imutável do store e o adaptador do Prompt-to-App pertencem à etapa de
integração. Não exponha este socket pela rede e não substitua os DTOs por
`argv`, shell ou configuração Docker recebida do cliente.

A composição de produção deve fornecer obrigatoriamente um `FileBuildIdGuard`;
um guard em memória é permitido somente em testes e não protege o `build_id`
contra replay depois de reinício do supervisor.

### Isolamento de organização/tenant

O protocolo v1 não carrega `tenant_id` em cada operação e, portanto, **uma única
instância compartilhada não é tenant-safe**. A integração deve iniciar uma
instância exclusiva por escopo de tenant, com `scopeId`, bearer secret, socket,
`instanceId`, raiz de artefatos, raiz de exports, journal e replay exclusivos.
Reutilizar qualquer uma dessas credenciais ou raízes entre tenants é configuração
inválida para produção. O `scopeId` é obrigatório e participa do namespace do
replay; isso evita colisões, mas não substitui o isolamento do processo e das
raízes. A integração não pode anunciar isolamento multi-tenant até provar essa
composição ponta a ponta.

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
