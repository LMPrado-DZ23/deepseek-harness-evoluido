# M6.3-C — núcleo de ingresso autenticado de artefatos

Estado: **CORE IMPLEMENTED / PRODUCTION WIRING NOT_WIRED**.

Esta fatia implementa e testa o núcleo isolado da opção A, sem alterar `unix-server.ts`, o supervisor principal, o manager, Docker, Compose ou Caddy. A conexão do handler ao socket de produção pertence à fatia de integração posterior e permanece fechada por ausência, não simulada.

## Contratos entregues

- `ArtifactIngressStore`: reserva de quota antes da leitura, journal atômico
  durável v2, intenção de limpeza antes de efeitos destrutivos e estados
  `RECEIVING`, `READY`, `CONSUMING`, `CONSUMED` e `FAILED`.
- `createArtifactIngressHttpHandler`: controle JSON pequeno `artifact.begin`/`artifact.abort` e `PUT /v1/artifacts/<upload_ref>` binário, autenticados antes de consumir o corpo.
- `createArtifactIngressUnixClient`: cliente streaming com `Content-Length`, backpressure, cancelamento e zero retry implícito.
- `CanonicalUstarValidator`: validação incremental de tar não comprimido; nenhum `Buffer.concat` ou corpo completo em memória no runtime.

## Invariantes

- `Content-Length` é obrigatório; `Transfer-Encoding` e `Content-Encoding` são recusados.
- Limites: 20.000 entradas, 256 MiB lógicos, 64 MiB por arquivo e 320 MiB no wire.
- Somente arquivo regular e diretório USTAR canônicos; checksum, blocos finais, padding, ordem e metadados são validados.
- Caminhos absolutos, `..`, barra invertida, NUL, UTF-8 inválido, Unicode não NFC, duplicatas/case-fold collisions, PAX/GNU/longname, links, FIFO, socket, device e sparse são recusados.
- SHA-256 do tar e do manifesto é recalculado no servidor. O hash declarado nunca substitui a validação.
- `upload_ref` é opaco e preso a escopo, `build_id`, digest da imagem, hash da política, tamanho e hash declarado; journal não contém organização, tenant, caminho lógico ou caminho físico.
- Consumo é único. No Unix, o arquivo é aberto uma vez com `O_NOFOLLOW`,
  validado como regular, `nlink=1`, dono e modo restrito, e o mesmo
  `FileHandle` aberto é transmitido ao Docker Engine. O caminho não é reaberto
  e `/proc/self/fd` não faz parte do contrato.
- O cliente só aceita `READY` depois de a resposta e o envio do corpo terem
  terminado; qualquer falha em um dos lados aborta o outro. Rejeições e
  exceções síncronas de `iterator.return()` são sempre observadas e contidas.
- Abort, desconexão e TTL levam a falha/quarentena; falha de limpeza é
  `CLEANUP_INCOMPLETE`. Arquivos em quarentena entram na quota, são validados
  como objetos seguros e são coletados por TTL.
- A identidade `device:inode` e o proprietário do spool são fixados no início
  e revalidados antes dos efeitos duráveis.

## Provas locais desta fatia

- TypeScript do pacote (`tsc -p tsconfig.build.json --noEmit`): PASS.
- Testes focados Linux: 135 PASS em seis arquivos, sem Docker ou instalação.
- Cobertura focada de `artifact-ingress.ts`, `artifact-ingress-client.ts`,
  `artifact-ingress-http.ts`, `docker-adapter.ts` e `docker-engine.ts`: 100%
  statements, branches, functions e lines.
- Regressão completa Linux com cobertura: 26 arquivos e **612/612 testes
  PASS**; cobertura global 98,18% statements, 97,04% branches, 99,68%
  functions e 99,37% lines.
- Regressão completa Windows: 18 arquivos executados e 8 específicos de Unix
  pulados; **405 PASS, 207 SKIPPED**, sem falha.
- Gate de portabilidade com self-test negativo: PASS, zero achado.
- `git diff --check`: PASS; `third_party/**`: zero diff.
- Self-test do pin upstream: PASS em cinco fixtures negativas. A verificação
  real do pin é **NOT_EXECUTABLE nesta base de integração**, pois o gitlink
  `third_party/deepseek-harness` não está materializado e não possui metadata
  Git/origin. Isso não foi reclassificado como passe nem contornado.
- O gate P37 e seus inventários não existem nesta base; validação de licença
  desta fatia é **NOT_PRESENT** e deverá ser reexecutada na integração que
  contém P37 antes de qualquer redistribuição.
- Varredura estática direta dos 14 arquivos alterados/adicionados: zero
  `TODO`/`FIXME`, chave privada ou padrão comum de credencial.
- Falhas injetadas: close/fsync/write/journal/quarentena, owner/mode,
  realpath, replay, concorrência, deadline/abort, settlement tardio, todas as
  fronteiras de crash entre publicação e `READY`, e entre quarentena e estado
  terminal.
- `unix-server.ts`: sem diff; rota de produção permanece `NOT_WIRED`.

## Validação de segurança da fatia

Rubrica aplicada aos achados candidatos: entrada controlável alcança o sink; precondições são realistas; impacto rompe um invariante desta fatia; reprodução focada falha antes da correção; teste de regressão passa depois da causa corrigida.

| Candidato | Fonte → controle → sink | Disposição e evidência |
| --- | --- | --- |
| M63C-V1, arquivo publicado órfão | stream autenticado → publicação atômica → falha entre `link` e journal READY | **reportable/corrigido**: o journal registra intenção antes do efeito; no reinício, um hardlink de mesma identidade é concluído de modo determinístico, formas divergentes falham fechadas e a quarentena permanece contabilizada até coleta comprovada. |
| M63C-V2, ancestral regular em tar | nome USTAR → validação incremental → futuro extrator | **reportable/corrigido**: arquivo `a` seguido por `a/b` é recusado antes de READY. |
| M63C-V3, cancelamento durante backpressure | fonte cliente → espera por `drain` → upload Unix | **reportable/corrigido**: a espera por `drain` usa o mesmo `AbortSignal`; teste com socket estagnado comprova término `ABORTED`. |
| M63C-V4, reabertura incompatível do artefato | arquivo validado → caminho `/proc/self/fd` → reabertura pelo Docker | **reportable/corrigido**: o mesmo `FileHandle` preso e validado é transmitido ao engine; teste prova que nenhum caminho é reaberto. |
| M63C-V5, resposta aceita antes do fim do upload | servidor responde cedo → fonte ainda falha → cliente aceita `READY` | **reportable/corrigido**: o exchange aguarda resposta e corpo; falha ou cancelamento de qualquer lado encerra o par e é testado. |

Incerteza residual explícita: o handler HTTP está testado como interface real em memória, mas o wiring no Unix socket de produção é `NOT_WIRED`; portanto esta prova não afirma disponibilidade externa nem lifecycle completo.

Nenhuma afirmação de build, prepare, export ou preview funcional é feita por esta prova.
