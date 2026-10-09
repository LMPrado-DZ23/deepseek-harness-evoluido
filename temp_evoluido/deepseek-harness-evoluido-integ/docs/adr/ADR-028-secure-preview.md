# ADR-028 — Preview local seguro e temporário

- Estado: Aceita
- Data: 2026-09-03
- Ressalva: implementada em M1/P34; capacidade local classificada como `BETA` ate operacao prolongada e revisao independente do checkpoint

## Contexto

O DZ23 STUDIO precisa permitir que uma pessoa leiga veja o protótipo verificado
sem publicá-lo. O aplicativo gerado é conteúdo não confiável: pode conter erro,
saída inesperada do modelo ou dependência vulnerável. Uma URL difícil de
adivinhar, uma denylist de fonte ou o iframe, isoladamente, não constituem a
fronteira de segurança.

## Zonas de confiança

O preview separa quatro zonas:

1. navegador da pessoa e iframe, sujeitos a conteúdo não confiável;
2. Caddy, única borda HTTP e autoridade de roteamento por origem;
3. plugin de preview do Studio, que revalida sessão, organização, tenant,
   projeto, run, hash do artefato e lifecycle;
4. supervisor sem rede, proxy mínimo do plano de dados e runtime do aplicativo
   gerado, sempre não confiável e sem credenciais do Studio.

O navegador nunca escolhe container, endereço, porta, imagem ou caminho. O
gateway resolve uma referência interna opaca emitida pelo runtime e vinculada ao
registro persistido de preview.

## Lifecycle e autoridade única

O domínio tenant-aware `studio_previews` é a única autoridade sobre o estado:
`REQUESTED → STARTING → READY → STOPPING → STOPPED`, com `FAILED` e `EXPIRED`
como estados terminais. O servidor define TTL padrão de 30 minutos e máximo de
duas horas, serializa start/stop e reconcilia órfãos após reinício.

Somente um run `PASSED`, pertencente ao mesmo projeto e com o mesmo
`artifact_sha256`, pode iniciar preview. Caddy não decide autorização, tenant ou
lifecycle; ele consulta o supervisor/gateway. A policy e a identidade existentes
continuam as autoridades de RBAC e autenticação. Nenhuma segunda autoridade é
criada no plugin de preview.

## Origem local e HTTPS futuro

No uso local, o Studio abre em `http://studio.dz23.localhost:<porta>` e cada
preview em `http://p-<id-aleatorio>.dz23.localhost:<porta>`. As origens são
distintas, mas pertencem ao mesmo site local; isso permite cookie host-only,
`HttpOnly` e `SameSite=Strict` no iframe sem usar TLS privado. `localhost` e
`p-<id>.localhost` não servem para este contrato: navegadores os tratam como
sites distintos e recusam o cookie no iframe.

O fluxo não usa `tls internal`, não instala CA raiz, não altera trust store,
DNS ou arquivo de hosts. HTTPS real, ACME, domínio público e acesso por celular
fora do host estão `NOT_EXECUTED` até prova específica e não podem ser inferidos
do teste local.

## Isolamento do runtime e rede

Cada preview cria o runtime com `NetworkMode=none`. O proxy mínimo compartilha
exclusivamente o namespace de rede desse runtime por
`NetworkMode=container:<runtime>` e fala com a aplicação por loopback. Nenhum
dos dois publica porta, ingressa em bridge Docker ou recebe Docker socket. O
supervisor também permanece em `network=none`; Studio, supervisor e proxy se
comunicam apenas por sockets Unix autenticados. Runtime e proxy não recebem
`NET_ADMIN`, `NET_RAW`, modo privilegiado ou qualquer capability. Ambos usam
raiz somente leitura, usuário não-root, escrita efêmera e limites de CPU,
memória e PIDs.

O staging do artefato também usa `network=none`. A inspeção física precisa
provar apenas a interface `lo`, tabela de rotas externas vazia e falha de DNS,
internet, metadata, host Docker e Studio. Se isso não puder ser provado sem
privilégio perigoso, o estado é `BLOCKED_EXTERNAL`, nunca fallback permissivo.

A denylist AST da fonte gerada — incluindo `use server`, `fetch`, `WebSocket`,
`XMLHttpRequest` e `EventSource` em posições executáveis — permanece uma defesa
secundária para diagnóstico precoce. Ela não substitui `network=none`, a rede
interna, a ausência de credenciais nem a política do runtime.

## Iframe, origem e admissão

O Studio preserva `X-Frame-Options: DENY` e `frame-ancestors 'none'`. Somente a
resposta do host do preview recebe CSP que autoriza exatamente a origem do
Studio, com `default-src 'self'`, `connect-src 'self'`, `form-action 'self'`,
`base-uri 'none'` e `object-src 'none'`.

O iframe usa `sandbox="allow-scripts allow-forms allow-same-origin"` e
`referrerpolicy="no-referrer"`, sem popup, top-navigation ou download. Como
`allow-scripts` junto de `allow-same-origin` aumenta a capacidade do conteúdo, a
origem distinta `p-<id>.dz23.localhost` e a separação de cookies são obrigatórias; o
aplicativo não é servido na origem do Studio. A origem isolada também não é
credencial: admissão opaca, sessão vigente e membership são revalidadas pelo
gateway em cada acesso relevante.

O cookie de sessão do Studio é host-only e `HttpOnly`. Como um preview pode
tentar criar outro cookie com o mesmo nome no domínio pai, a autenticação
preserva valores duplicados e aceita somente um candidato que passe a validação
criptográfica, com limite de trabalho. CSRF é derivado da sessão, guardado pelo
navegador em `sessionStorage` e enviado em cabeçalho; nenhum cookie legível por
JavaScript participa dessa decisão. Em HTTP local, a omissão de `Secure` exige
configuração explícita `loopback-http`, bind em `127.0.0.1` e allowlists apenas
para `localhost`, subdomínios `.localhost` ou `127.0.0.1`. Servidor e borda real
continuam `secure` por padrão.

O convite opaco enviado por `postMessage` pode ser trocado uma única vez e
expira em 120 segundos. Heartbeat renova somente a admissão já trocada, nunca
um convite ainda não usado. O cookie host-only recebe `Max-Age` calculado pelo
servidor e é renovado pelo navegador após cada heartbeat, sem jamais ultrapassar
o vencimento atual do preview ou da admissão. Códigos de acesso capturados no runtime só aparecem
para a mesma pessoa e sessão que abriu aquela prévia, além das validações de
papel, organização, tenant e projeto; sessão ativa e membership são revalidadas
imediatamente antes da leitura.

O encerramento concede 75 segundos ao supervisor. Sinais de shutdown abortam
RPCs e staging em andamento antes do drain e o garbage collector remove
stager, runtime, proxy, sockets e volumes rotulados; sobreviventes mantêm a
operação em falha observável.

## E-mail no preview

Aplicativos gerados usam o modo `studio-preview` enquanto estiverem em preview.
Nenhum SMTP ou provedor externo é chamado. O código de acesso é escrito apenas
em volume efêmero exclusivo daquele preview. Uma rota autenticada do Studio pode
exibi-lo somente após revalidar sessão, organização, tenant, projeto e preview.
O código não entra em URL, log, bundle ou resposta cross-tenant e é removido ao
encerrar o runtime.

## Estados honestos

Até que lifecycle, Caddy, isolamento de rede, admissão, revogação, iframe e
`studio-preview` sejam exercitados com o runtime real, a capacidade permanece
`NOT_EXECUTED` ou `BETA` conforme a evidência disponível. O resultado local é
`PREVIEW_OK`, nunca "publicado", "em produção" ou "aplicação pronta".

## Capacidade persistente e recuperação

No perfil de borda, `@dz23-studio/storage-postgres` publica a mesma autoridade
PostgreSQL de capacidade consumida pelo Preview. O overlay declara
`studioCapacity` como dependência de lifecycle, impedindo a corrida entre
plugins irmãos durante o boot. A inicialização falha fechada
se essa autoridade não existir ou não oferecer takeover atômico. Uma
recuperação lê a lease de `preview:<previewId>`, valida escopo e alocação e
rotaciona o fencing token por compare-and-swap antes de controlar o runtime.

Uma lease destacada ligada a registro terminal é tomada e mantida em
`CAPACITY_RECOVERY_QUARANTINE`. Ela não é liberada automaticamente: sem o
supervisor validar o fencing token, uma criação iniciada pela instância antiga
pode materializar depois de qualquer fotografia de inventário. O custo de
segurança é intervenção operacional para liberar essa quarentena.

Esse contrato fecha reinício/failover de uma implantação **single-active**. Não
autoriza active-active: o backend de domínios ainda impõe escritor único, e o
supervisor não recebe o fencing token em cada operação. Active-active permanece
`NOT_IMPLEMENTED` até que start, stop, health, proxy e coleta rejeitem tokens
antigos no próprio supervisor.
