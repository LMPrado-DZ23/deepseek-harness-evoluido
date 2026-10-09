# M73 — Barreira multiusuário do Assistente

Estado: **GO para o limite fail-closed**. Base M71
`646c47b53ad7c76c0ca3010e6abdd7001aec0ae0`. Implementação isolada em
`codex/m73-assistant-tenant-boundary`; não autoriza merge na principal, push,
PR, deploy ou Docker.

## Problema e evidência

O cliente oficial do Harness autentica o navegador no processo, mas não recebe
o principal DZ23 em cada operação lógica. No upstream fixado em
`6c705be1ce6774a000d061da41d1823b03a3d42c`, o cookie `BrowserAuth` não carrega
organização ou tenant; listagem, página, histórico, prompt e fork recebem o ID
da sessão sem um principal DZ23; e o transporte `/api/remote.mux` autentica a
conexão WebSocket antes de abrir fluxos lógicos sem um interceptor público por
frame. Logo, esconder apenas `session/list` não impediria acesso por ID ou por
um WebSocket já autenticado.

## Correção

- a troca `/api/studio/identity/harness/session` só libera o cliente nativo no
  modo pessoal/loopback, com exatamente um usuário, e para a sessão desse
  usuário;
- quando `edge.required` está ativo, a troca retorna 403 sem `Location` e antes
  de emitir cookie do Harness;
- a entrada do Assistente verifica o mesmo contrato antes de criar ou adotar
  sessão;
- a borda permite somente `/studio`, `/studio/*` e `/api/studio/*` depois do
  `forward_auth`; raiz do Harness, `/api/session/*`, demais RPC e
  `/api/remote.mux` terminam em 404;
- a tela de login volta para `/studio/`, não para a troca de cookie nativo;
- a capacidade para equipe permanece `NOT_SUPPORTED`. Nenhuma filtragem parcial
  é apresentada como isolamento de tenant.

## Provas no WSL2/ext4

Clone de teste: `/home/leandro/dz23-gates/m73-clean-dc35c1f`. Conteúdo do
upstream: 8.953 entradas, manifesto SHA-256
`862b92782c2f5cd67f81debd1116b16150dfafd84fb4ce2602a729f9cf3d26dc`.
Instalação offline e lock congelado passaram. Como o postinstall do upstream
não suporta o `core.worktree` de um worktree Git vinculado, seus `lib/**` já
provados na M71 foram copiados mecanicamente para este clone de teste; nenhuma
saída de build foi sincronizada de volta à branch.

- `pnpm typecheck`: PASS;
- `pnpm build`: PASS, interface e 16 plugins;
- suíte raiz: **2.031 PASS / 62 SKIP / 0 FAIL**, 126 arquivos aprovados e seis
  specs PostgreSQL puladas por ausência de DSN;
- cobertura global: 96,11% statements, 93,56% branches, 96,61% functions e
  98,14% lines;
- `plugins/identity/src/**`: **100%** nas quatro métricas;
- testes focados finais: 47/47;
- app web separado: 56/56;
- `ASSISTANT_PACKAGE_PROOF=PASS`, com treze ferramentas e somente o provider
  local `spawn-in-process`;
- gates de escopo e 24 rotas de domínio, catálogo de ferramentas,
  portabilidade e i18n: PASS;
- gate de pin: PASS para commit, árvore, origin e manifesto; self-test PASS com
  cinco fixtures negativas.

O primeiro passe cumulativo encontrou um teste legado que ainda esperava 303
no modo edge. A expectativa foi corrigida para 403. O primeiro passe de
cobertura encontrou ramos defensivos sem exercício; testes foram adicionados e
o gate crítico fechou em 100%, sem redução de limiar.

## Limites honestos

- o primeiro clone de teste materializou por engano um `.git` interno com
  origin do bundle e foi corretamente recusado pelo gate. A prova positiva foi
  repetida em `/home/leandro/dz23-gates/m73-pin-gate-9d3faf8`, com submodule
  clonado da origem oficial no commit fixado, e passou;
- a prova estática do Caddy cobre a allowlist e as negativas, mas Docker segue
  desligado; proxy, WebSocket e bloqueios em Caddy físico são `NOT_EXECUTED`;
- chat oficial no modo pessoal continua BETA conforme M71; chat de equipe e
  multiusuário continuam `NOT_SUPPORTED`;
- nenhuma prova de celular físico, HTTPS público, modelo externo ou teste com
  pessoa leiga foi executada;
- a M73 não implementa RLS no PostgreSQL e não interfere na M72 reservada ao
  Claude.

O resultado fecha uma exposição indevida; não transforma o produto em pronto
nem valida a experiência para pessoas leigas.
