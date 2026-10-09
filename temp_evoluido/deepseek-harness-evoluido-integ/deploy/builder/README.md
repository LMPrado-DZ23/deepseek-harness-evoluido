# DZ23 STUDIO builder

Esta imagem é construída no setup aprovado T2. A imagem final é referenciada
pelo ID `sha256:` completo; nenhuma tag mutável é aceita pelo runtime.

Em cada run, o executor usa rede `none`, usuário não-root, raiz somente leitura,
capabilities removidas, `no-new-privileges`, limites de CPU/memória/processos e
somente dois mounts: diretório da run `rw` e store offline `ro`.

O store v2 contém os lockfiles fixados dos templates estático e Next.js. O
Next.js é o padrão; o estático só pode ser selecionado explicitamente. A
telemetria do Next fica desativada no build, teste e runtime.
