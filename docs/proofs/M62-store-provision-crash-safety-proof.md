# M6.2 — Prova de crash safety do provisionamento do template store

**Base:** `codex/m62-store-provision@9e3dae00c2752c187b4ce724ac9955146819c7cd`
**Branch isolada:** `codex/m62-store-coverage`
**Escopo:** `plugins/builder-supervisor`; sem merge, push, PR ou deploy.

## Resultado

O protocolo de recuperação do provisionador passou a usar duas camadas com
responsabilidades separadas:

- `.provision.guard` é um inode permanente, privado e validado, usado apenas
  como mutex local de processo via `flock(2)`; não é autoridade de domínio;
- lock, claim e testemunho de takeover continuam sendo a evidência durável da
  operação. Toda criação, retomada, liberação e limpeza desses caminhos ocorre
  sob o mesmo guard. Cópia e hash do store ficam fora da seção crítica;
- o descritor do guard é aberto com `O_NOFOLLOW`, revalidado e herdado como fd
  3 pela forma sem comando
  `/usr/bin/flock --exclusive --nonblock --conflict-exit-code 200 3`.
  O pai mantém o `FileHandle` aberto durante a seção crítica, portanto queda
  ou `SIGKILL` libera a exclusão no kernel;
- a raiz da instância é `0700`; guard regular, `0600`, `nlink=1`, owner,
  realpath, device e inode são revalidados. Guard ausente só pode ser criado no
  bootstrap de uma raiz vazia; depois de existir estado, ausência ou troca
  falha fechada;
- `/usr/bin/flock` também é validado por identidade e permissões. Código 200 é
  concorrência esperada; sinal ou qualquer outro código não zero falha fechado;
- esta implementação suporta somente Linux em ext4 ou XFS. `/mnt/*`, NFS,
  CIFS, FUSE, btrfs e Windows são recusados. Mesmo UID faz parte da TCB local.

## Provas adversariais

Os testes usam subprocessos reais e cobrem:

- `SIGKILL` depois de criar o takeover e antes de remover L0;
- `SIGKILL` depois de remover L0 e antes do cleanup;
- `SIGKILL` durante a cópia parcial do store;
- dois retomadores simultâneos e preservação de um L1 instalado no intervalo;
- 50 processos concorrentes disputando o mesmo guard;
- 50 processos pausados depois de todos observarem `ENOENT` na mesma raiz
  vazia: exatamente um cria o guard e conclui; os demais terminam somente como
  `PROVISION_BUSY` ou `ALREADY_PROVISIONED`, nunca recovery failure;
- release concorrente com reclaim;
- identidade antiga de outro boot, hardlink concorrente, `ENOENT` benigno,
  inode/owner/mode/nlink divergentes, symlink, binário inválido e códigos de
  saída/sinais do `flock`;
- liberação de descritores e responsividade do event loop;
- nenhum arquivo chamado `3` criado no cwd ou na raiz da instância;
- erro gracioso durante target parcial, cleanup e retry idempotentes.

O fixture rastreado
`plugins/builder-supervisor/tests/fixtures/store-provision-child.ts` é o child
real usado nas provas de concorrência e crash.

## Gates executados

Ambiente: Ubuntu em WSL2, ext4, Node `22.23.1`.

- suíte focada de `store-provision.spec.ts`: **44/44 PASS**; a execução com
  coverage levou **66,52 s**;
- suíte canônica do pacote, `maxWorkers: 1`: **338/338 PASS**, 13 arquivos,
  **60,14 s** na revisão incremental;
- suíte canônica com coverage: **337/337 PASS**, **78,45 s**;
- cobertura global: **96,88% statements / 94,80% branches / 99,42% functions /
  99,06% lines**;
- `store-provision.ts` na cobertura focada incremental: **90,30% statements /
  84,80% branches / 97,93% functions / 97,71% lines**; gate D30 de
  `90/80/95/95` atendido sem reduzir
  threshold ou ignorar código;
- mutações de guard e recuperação: **11 mortas / 0 sobreviventes**;
- mutação incremental que restaura a rejeição incorreta de um guard criado
  concorrentemente: **morta** pelo stress de bootstrap;
- `tsc -p tsconfig.build.json --noEmit`: **PASS**, 5,74 s;
- `tsc -p tsconfig.build.json`: **PASS**, 4,13 s;
- `check-portability.mjs --self-test`: **PASS**; verificação real: **PASS**;
- `check-upstream-pin.mjs --self-test`: **PASS**, 5 fixtures negativas;
- `git diff --check`: **PASS**;
- `third_party/**`: **zero diff**;
- nenhum child de provisionamento ou processo `flock` permaneceu depois dos
  testes de stress e coverage.

## Interferência ambiental observada

Uma execução não canônica a partir da raiz ignorou o `vitest.config.ts` do
pacote e executou arquivos em paralelo: sete testes pesados de subprocesso e o
deadline Unix falharam sob carga. Na execução canônica inicial, enquanto outro
agente copiava milhares de arquivos de `/mnt/c` para ext4 e o WSL tinha acabado
de reiniciar, somente o segundo RPC do teste Unix retornou 504. O arquivo
`unix-server.spec.ts` era blob-idêntico à base; isolado, passou **32/32 em
3,42 s**. Depois que o rsync cessou, a repetição canônica passou **337/337** e a
revisão incremental passou **338/338**, sem alterar deadline, assertion ou
código Unix. A falha foi classificada como
interferência de I/O/carga, não ocultada.

## Limites honestos

- O gate P37 (`scripts/check-release-licenses.mjs`) não existe nesta base:
  **NOT_PRESENT**.
- A verificação real de `check-upstream-pin.mjs` não é executável neste
  worktree local sem remote `origin`; o self-test passou e `third_party/**`
  permaneceu intocado.
- `check-upstream-content.mjs` na cópia originada do checkout Windows falha por
  symlink fixado materializado como arquivo (`.agents/notes/AGENTS.md`). Isso é
  uma limitação conhecida do clone Windows e não é reportado como PASS.
- O guard protege concorrência entre processos no mesmo host/filesystem. Ele
  não transforma storage compartilhado, Windows ou filesystems remotos em
  configuração suportada.
