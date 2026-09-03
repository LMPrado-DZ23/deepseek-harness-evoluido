# ADR-028 — Preview local seguro e temporário

Status: aceito como decisão arquitetural; implementação e provas permanecem em
andamento na M1/P34.

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
3. supervisor/gateway do Studio, que revalida sessão, organização, tenant,
   projeto, run, hash do artefato e lifecycle;
4. runtime do aplicativo gerado, sempre não confiável e sem credenciais do
   Studio.

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

No uso local, o navegador abre
`http://p-<id-aleatorio>.localhost:<porta-do-studio>`. Cada preview recebe origem
distinta, mas continua no namespace loopback que os navegadores reconhecem como
contexto local confiável. O fluxo da pessoa não usa `tls internal`, não instala
CA raiz, não altera o trust store e não modifica o arquivo de hosts.

Uma prova automatizada separada pode exercitar HTTPS com `tls internal` somente
dentro de contêiner ou perfil descartável. A CA permanece confinada a esse
ambiente e nunca é instalada no host. HTTPS real, ACME, domínio público e acesso
por celular fora do host estão `NOT_EXECUTED` até prova específica; não podem ser
inferidos do teste local.

## Isolamento do runtime e rede

Cada preview usa rede Docker interna dedicada que contém apenas o runtime e o
gateway confiável. O runtime não entra na rede padrão, não publica porta no host,
não recebe `NET_ADMIN`, `NET_RAW`, modo privilegiado ou qualquer capacidade. A
raiz é somente leitura, o usuário é não-root, a única escrita ocorre em volume
efêmero dedicado, e CPU, memória e PIDs têm limites.

Build e processos que não precisam receber tráfego usam `network=none`. Para o
servidor de preview, a rede interna dedicada permite somente o ingresso do
gateway; nenhuma rota de saída para internet, DNS externo, metadata, host,
Harness ou Postgres é permitida. A inspeção do runtime e tentativas reais de
HTTP, TCP e DNS de dentro do contêiner são a autoridade de segurança. Se o
isolamento não puder ser provado sem privilégio perigoso, o estado é
`BLOCKED_EXTERNAL`, nunca fallback permissivo.

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
origem distinta `p-<id>.localhost` e a separação de cookies são obrigatórias; o
aplicativo não é servido na origem do Studio. A origem isolada também não é
credencial: admissão opaca, sessão vigente e membership são revalidadas pelo
gateway em cada acesso relevante.

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
