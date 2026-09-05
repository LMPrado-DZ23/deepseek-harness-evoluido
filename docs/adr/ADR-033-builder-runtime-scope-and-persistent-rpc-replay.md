# ADR-033 — Escopo físico do builder e replay RPC persistente

**Status:** Aceito para a fundação M6.2
**Data:** 2026-09-05

## Contexto

O Builder Supervisor cria recursos privilegiados no Docker e atende RPC por
socket Unix. Identificadores lógicos de organização, tenant e instância não
podem virar autoridade enviada pelo cliente, nomes previsíveis de recursos ou
labels que exponham a topologia lógica. O replay idempotente também não pode
ficar sob `/run`, porque essa raiz é efêmera e perde a proteção após reinício.

## Decisão

O servidor deriva uma única identidade física opaca:

```text
scope_id = "s_" + first_48_hex(
  SHA-256(canonical_json({
    domain: "com.dz23.studio.builder.runtime-scope",
    version: 1,
    installation_id,
    tenant_id,
    instance_id
  }))
)
```

`installation_id` é composto por 64 caracteres hexadecimais minúsculos.
`tenant_id` e `instance_id` aceitam apenas identificadores fechados, de 1 a 64
caracteres. Entradas inválidas falham antes de qualquer efeito externo.

`scope_id` é a única identidade operacional:

- nomes de contêineres, volumes e template store são derivados dele;
- toda label ou filtro Docker administrado contém
  `com.dz23.studio.installation-id` e `com.dz23.studio.scope-id`;
- a attestation expõe apenas `scope_id`, nunca `org_id`, `tenant_id` ou
  `instance_id`;
- nenhum pedido RPC recebe caminho de socket ou qualquer desses identificadores
  lógicos.

O socket é sempre derivado pelo servidor como
`/run/dz23-studio/builder/instances/<scope_id>/rpc.sock`. O caminho é validado
em bytes UTF-8 tanto na derivação quanto na API do listener e não pode exceder
107 bytes.

O replay RPC é obrigatório e persistente. A configuração só aceita a raiz exata
`<stateRoot>/instances/<scope_id>/rpc-replay`; o listener separa os registros por
`scope_id` e `policy_sha256`. Raiz, diretório do escopo e diretório da política
são criados com modo `0700` e validados quanto a caminho canônico, tipo, symlink,
dono e permissões antes de o socket ser aberto. Qualquer divergência falha
fechada. Nunca se usa `${socketPath}.requests` nem outra localização em `/run`.

## Consequências

Dois tenants com o mesmo `instance_id` recebem escopos, recursos Docker e replay
distintos. Reiniciar o supervisor conserva a resposta de uma requisição idêntica
sem redispatch; trocar o escopo ou a política não reutiliza a resposta anterior.
O Docker pode reconciliar somente recursos da instalação e do escopo atuais.

Os identificadores lógicos permanecem apenas na configuração protegida, onde o
servidor os usa para derivar o escopo. Não são registrados na attestation nem no
protocolo RPC.

## Fora desta decisão

Esta ADR não ativa o supervisor, não implementa manager multi-runtime,
materialização de configuração/segredos, Compose, adaptação Prompt-to-App nem
resolve a divergência de hash do template store. Essas provas pertencem às
fatias seguintes.

## Evidência exigida

- derivação determinística e separação entre tenants com a mesma instância;
- rejeição de IDs malformados;
- caminho real máximo medido em bytes (`<= 107`) e rejeição no listener acima
  desse limite;
- nomes, labels e filtros Docker sem identidade lógica e com isolamento de
  escopo;
- protocolo e attestation sem `org_id`, `tenant_id` ou `instance_id`;
- replay depois de reinício e não-replay entre escopos;
- falha anterior ao bind para raiz de replay com modo/dono/caminho inseguros.
