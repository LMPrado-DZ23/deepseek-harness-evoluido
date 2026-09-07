# M84-A — autoverificação da imagem antes do empacotamento

Data: 07/09/2026. Estado: **IMPLEMENTED / IMAGE BUILD NOT_EXECUTED** em
`codex/m84-image-self-verification`. Base:
`80b89bead93e057ed03b6bff7fa29e44d806a203`. Código funcional:
`4667e2f194eaecf4ea7965ae00a7d29799a9adb4`. Harness upstream preservado em
`6c705be1ce6774a000d061da41d1823b03a3d42c`.

Esta prova não autoriza merge, push, PR, deploy, execução Docker ou remoção de
artefatos compilados rastreados.

## Mudança

O estágio `build` da imagem agora precisa partir diretamente de `toolchain` e
executa, nesta ordem:

1. instalação offline e congelada na topologia de desenvolvimento, que mantém
   uma identidade canônica de tipos;
2. build dos pacotes;
3. typecheck agregado;
4. suíte Vitest determinística com um worker;
5. remoção somente da instalação de desenvolvimento dentro do estágio;
6. ativação do lock/workspace de release;
7. reinstalação offline e deploy moderno do runtime.

O runtime de release só é materializado depois das três provas de fonte. O
PostgreSQL físico continua no job dedicado; os testes que exigem DSN ficam
pulados dentro da construção da imagem e não são apresentados como executados.

O gate `check-image-lock.mjs` deixou de procurar palavras no Dockerfile bruto.
Ele monta instruções lógicas, ignora comentários, limita a análise ao estágio
`build`, exige o ancestral `toolchain`, unicidade e comandos exatos. O job
Windows do workflow passa a executar também o contrato de lock/imagem.

## Revisão adversarial e correções

A revisão independente encontrou e reproduziu três bypasses antes do commit:

- `RUN` substituído por comentários com as palavras esperadas;
- estágio `build` herdando de `dependency-fetch`, onde a topologia de release
  já estava ativa;
- `pnpm build` substituído por `echo` ou terminado com `|| true`.

Todos foram transformados em testes negativos. A revisão final retornou
**GO** e nenhum arquivo foi alterado pelo revisor.

## Provas executadas

- comando equivalente ao job Windows, agora incluindo
  `tests/portability/image-lock.test.mjs`: 30/30 `PASS`;
- contrato específico de lock/imagem: 5/5 `PASS`;
- `node scripts/check-image-lock.mjs`: `IMAGE_LOCK=PASS`;
- `git diff --check`: `PASS`.

A base M83 usada por esta fatia já havia passado em clone limpo WSL2/ext4:
2.034 testes, 62 integrações PostgreSQL puladas, zero falha. M84-A não altera
fonte ou comportamento de runtime; altera somente a cadeia que os verifica e
empacota.

## Limites e pendência de decisão

- a imagem não foi construída nesta fatia: `NOT_EXECUTED`;
- o workflow existe localmente, mas não há remoto: execução GitHub Actions
  `NOT_EXECUTED`;
- 113 arquivos `plugins/*/lib/**` continuam rastreados, embora sejam saídas de
  build ignoradas. A remoção do índice não foi autorizada e não foi realizada;
- enquanto esses arquivos permanecerem, o workflow conserva a exclusão
  temporária deles na checagem final. Fechar M84-B exige autorização explícita
  para removê-los do índice e então eliminar a exclusão;
- PostgreSQL físico, Caddy/Docker real, Windows lifecycle real e celular físico
  continuam fora desta prova.

## Decisão técnica

M84-A torna impossível produzir a imagem pelo Dockerfile oficial sem executar
build, typecheck e a suíte não-PostgreSQL na topologia correta. O checkpoint
está pronto para parecer independente do Claude. Ele não transforma a imagem
em comprovada nem resolve os artefatos `lib` rastreados.
