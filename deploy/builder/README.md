# DZ23 STUDIO builder

Esta imagem é construída no setup aprovado T2. A imagem final é referenciada
pelo ID `sha256:` completo; nenhuma tag mutável é aceita pelo runtime.

Em cada run, o executor usa rede `none`, usuário não-root, raiz somente leitura,
capabilities removidas, `no-new-privileges`, limites de CPU/memória/processos e
somente dois mounts: diretório da run `rw` e store offline `ro`.
