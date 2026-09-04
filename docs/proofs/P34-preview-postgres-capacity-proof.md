# P34 — recuperação de capacidade PostgreSQL do Preview

- Base: `codex/p30-policy-foundation@16765ca`.
- Implementação: `codex/preview-capacity-wiring` (pin atualizado no commit de
  documentação imediatamente posterior ao fechamento do código).
- Ambiente canônico: WSL2/ext4, Node 22.23.1 e pnpm 11.7.0.
- PostgreSQL: contêiner descartável `postgres:16-alpine`, digest observado
  `sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685`.

## Contrato provado

O plugin `storage-postgres` publica uma autoridade de capacidade PostgreSQL no
mesmo boot do backend de domínios. O Preview em modo `edge` a resolve pelo
contexto; o overlay declara a dependência de lifecycle e recusa iniciar sem uma
implementação distribuída que ofereça takeover.

Na recuperação de um preview ativo, o serviço valida `ownerId`, organização,
tenant, projeto e alocação, então executa takeover compare-and-swap da lease.
O fencing token é rotacionado; a referência anterior deixa de poder renovar ou
liberar a geração. Uma lease destacada de registro terminal também é assumida,
mas permanece em `CAPACITY_RECOVERY_QUARANTINE`: sem fencing no supervisor, uma
runtime antiga ainda pode materializar depois de uma leitura vazia. A
capacidade não é liberada automaticamente nesse estado.

## Gates executados

- instalação offline com lock congelado: `PASS`;
- runtime-governor + Preview: 373 testes aprovados, 2 skips explícitos de
  filesystem no corte completo;
- recorte final de recuperação e lifecycle: 60/60;
- typecheck raiz: `PASS`;
- builds de runtime-governor, storage-postgres e preview: `PASS`;
- PostgresCapacityGovernor em PostgreSQL 16 real: 11/11;
- registro e descarte do serviço `studioCapacity` no plugin real: 1/1;
- contêineres descartáveis removidos pelos traps; nenhum volume de prova foi
  criado.

## Limite honesto

Este checkpoint prova recuperação/failover **single-active**. O armazenamento
de domínios ainda impõe escritor único e o supervisor não recebe o fencing
token em cada operação. Active-active permanece `NOT_IMPLEMENTED`; esta prova
não deve ser descrita como suporte multi-réplica.
