# `@dz23-studio/staging`

Núcleo governado para preparar publicações imutáveis em **staging**. Este
pacote registra intenção, aprovação T2, exclusão por destino físico, efeito do
provider e reconciliação sem confundir um efeito incerto com falha definitiva.

## O que existe nesta fatia

- journal tenant-aware em `studio_staging_releases`;
- artefato selado por hashes de conteúdo, manifesto, aceite, SBOM, proveniência,
  imagem do builder e política;
- operação idempotente e geração crescente por destino físico;
- publicação e rollback com receipt estrito;
- lease com fencing e quarentena quando um efeito externo conflita com o
  estado local;
- estado `RECONCILIATION_REQUIRED` para qualquer efeito inconclusivo.

## O que não existe

Não há rota HTTP, botão, provider real, montagem no Harness, acesso a produção
ou adaptação de diretórios locais. A integração só pode ser acrescentada quando
existirem uma fonte durável de artefatos, uma autoridade T2 real e um adapter
de armazenamento com as garantias atômicas declaradas pelas portas deste
pacote.
