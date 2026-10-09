# ADR-034 — Materialização verificável do template store em volume Docker

- Estado: Aceita
- Data: 2026-09-05
- Ressalva: para a fundacao M6.3. Docker real continua `NOT_EXECUTED` neste checkpoint; os testes usam uma implementacao adversarial da porta Docker e arquivos reais no `/tmp` ext4 do WSL2
- Numero compartilhado com: ADR-034-builder-multi-runtime-manager

## Contexto

O provisionamento publica no host um envelope selado
`<version>/{tree,.complete}`. O builder, porém, instala dependências a partir de
um volume Docker. Labels não provam o conteúdo desse volume e o verificador
anterior calculava um hash diferente do manifesto canônico.

## Decisão

- O nome físico deriva, com separação de domínio, somente de
  `installation_id`, `scope_id`, versão e SHA-256 da árvore. Tenant, organização
  e instância lógica nunca entram em nome, label, filtro ou protocolo Docker.
- O materializador valida o envelope selado no host contra o mesmo
  `TemplateStoreManifest` e a mesma função `computeTemplateTreeSha256` usados
  pelo provisionador.
- Um claim-contêiner determinístico é criado antes do volume. Seu nonce liga o
  claim ao volume. Um claim vivo ou ainda dentro do TTL devolve `BUSY`; somente
  `created`, `exited` ou `dead` após o TTL autoriza recuperar o volume
  incompleto com o mesmo nonce. `created` cobre a queda entre criação e start;
  `running`, `restarting`, `paused` e `removing` nunca são tomados. A operação
  tem deadline de 10 minutos e o claim autoexpira em 15.
- `createVolume` nunca é tratado como `no-replace`: o nome é consultado antes e
  depois. Um volume surgido na corrida e sem o nonce da tentativa não é apagado.
- Na recuperação, o volume ligado ao nonce expirado é removido enquanto o claim
  antigo ainda existe. Transporters com o mesmo nonce são validados por nome,
  identidade e ID, encerrados e removidos antes do volume; só então o claim é
  removido e substituído. O volume só é removido quando carrega o mesmo nonce;
  um volume anterior preservado durante uma sondagem de reuse é revalidado pelo
  claim seguinte. Assim uma nova queda não deixa volume montado ou órfão entre
  duas gerações de claim.
- A imagem builder já fixada é o único transporter. O comando é `node -e`
  fixo, sem shell ou entrada do modelo. Rede `none`, rootfs somente leitura,
  usuário numérico, `CapDrop ALL`, `no-new-privileges`, sem bind, porta ou
  imagem adicional são invariantes. O transporter autoexpira depois de 12
  minutos, acima do deadline de 10 minutos, e usa `AutoRemove`; assim uma queda
  do processo pai não deixa um contêiner de transporte vivo para sempre. O
  claim não usa `AutoRemove`, pois precisa permanecer como witness.
- O verificador público adquire o mesmo claim determinístico. Isso serializa a
  leitura com a materialização e liga seu transporter ao mesmo nonce; uma queda
  antes ou depois do `start` é recuperada após o TTL sem varrer ou encerrar um
  transporter ativo de outra tentativa. `BUSY` é apenas inelegibilidade para o
  preflight, enquanto conflito de identidade e limpeza incompleta falham
  fechados.
- A verificação pública tem deadline próprio de 8 minutos. Seu orçamento máximo
  conservador de cleanup é 2 minutos; a soma permanece estritamente abaixo do
  TTL de 15 minutos do claim. Antes de liberar o claim, o verificador prova que
  ID, estado e labels ainda pertencem à geração adquirida, que nenhum
  transporter daquela geração restou e que o nonce do volume não mudou.
- A árvore segue em tar determinístico; `.complete` segue em um segundo tar e
  sempre por último. Antes disso o volume precisa estar vazio.
- `templateStoreUstarEntryPath` é a gramática exportada para qualquer produtor
  de manifesto: além do caminho lógico seguro, ela exige que `tree/<path>`
  caiba nos campos `name`/`prefix` USTAR. O materializador e o parser aplicam a
  mesma regra. O provisionador compartilhado ainda precisa adotar esta função
  em um commit de integração separado; `store-security.ts` permanece cópia
  byte a byte de sua origem e não foi alterado nesta branch.
- Elegibilidade exige download pela Docker Archive API e parsing USTAR estrito
  no host, com limites de bytes/entradas/caminhos e rejeição de PAX/GNU,
  symlink, hardlink, device, FIFO, duplicidade e traversal. O host reconstrói o
  manifesto e usa a canonicalização compartilhada; labels nunca bastam. O
  preflight externo também recusa qualquer volume enquanto o claim
  determinístico ainda existir.
- A entrada raiz do volume é apenas a fronteira criada e gerida pelo driver
  Docker: precisa ser um diretório único, mas seu UID/GID e modo não são usados
  como prova. Essa exceção não alcança `tree`, seus descendentes nem
  `.complete`, que continuam exigindo UID/GID 10001 e modos 0555/0444. Assim o
  contrato funciona entre drivers e sistemas sem presumir que metadata do
  mountpoint da imagem será copiada para um volume novo.
- Builds montam a raiz do volume elegível somente como read-only e executam
  `pnpm install` com `--store-dir /template-store/tree`, que corresponde ao
  layout materializado `tree/** + .complete`. Falha, cancelamento
  ou conteúdo inválido removem apenas recursos ligados ao nonce atual; limpeza
  tem prazo e falha fechada. Se a limpeza do transporter ou volume não puder ser
  provada, o claim não é liberado: ele permanece como witness recuperável após
  expirar.

## Consequências

Uma queda pode deixar claim e volume incompleto, mas não os torna elegíveis. O
retry espera o TTL, prova que o claim está em um estado seguro explicitamente
enumerado e recupera somente o volume com o mesmo nonce. Conteúdo de volume
válido continua sendo revalidado no preflight. A
confiança no isolamento Docker continua limitada à autoridade do supervisor e
à prova futura com daemon real/rootless. Em particular, a cópia real por
Docker Archive API, a metadata observada entre drivers e a impossibilidade de
mutação do mount read-only continuam `NOT_EXECUTED` enquanto Docker estiver
desligado; os testes deste checkpoint validam contrato e fixtures, não esse E2E.

O caller de produção também permanece fora desta branch: o manager deve obter
o envelope e manifesto do provisionador, executar a materialização e somente
depois iniciar `load/compose/listen`. Falha deve produzir `BLOCKED_EXTERNAL` sem
subir runtime ou socket; esse wiring e sua prova pertencem a commit separado.
