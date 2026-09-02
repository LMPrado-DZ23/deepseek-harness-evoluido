# Rascunho upstream — storage-domain não oferece coordenação cross-process

Base observada: `deepseek-ai/deepseek-harness@6c705be1ce6774a000d061da41d1823b03a3d42c`.

## Problema reproduzível

`DomainFacility.open()` chama `loadAll()` uma vez e `DomainImpl` passa a tratar
esse snapshot como estado autoritativo. A cadeia de escrita e os eventos existem
somente no processo. Dois processos podem carregar S0; se A escreve S1 e sai,
B ainda pode escrever a partir de S0 e perder S1, mesmo que um backend impeça
escritores simultâneos. Repositórios que atualizam dois registros também não têm
transação, CAS ou batch no `KvUnit`.

## Impacto

Um backend PostgreSQL pode cumprir a atomicidade de cada primitiva e ainda assim
não tornar o formulário de domínio ativo/ativo, um standby quente seguro ou uma
operação composta transacional. Valores são JSON opacos e não carregam tenant
context, logo RLS por requisição também não pode ser imposto nesse nível.

## Proposta para discussão

Adicionar um contrato opcional, sem quebrar os backends atuais, para:

- lease/fencing epoch antes do `loadAll` e em cada commit;
- invalidação/reload de domínio após troca de holder;
- batch/CAS transacional para múltiplas mutações;
- scope explícito no descriptor/operação para backends tenant-aware;
- suíte compartilhada cross-process e de perda de conexão.

Até existir esse contrato, a documentação deveria afirmar expressamente que o
formulário é single-process e que trocar a mídia por PostgreSQL não muda isso.
