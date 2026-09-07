# Estado da missão autônoma DZ23 STUDIO

- `mission_id`: `M1-M6-finalizacao-2026-09-04`
- `objective`: integrar e provar M1-M6 com segurança, sem push, PR, deploy ou exclusões não autorizadas
- `state`: `INTEGRATING_AND_PROVING`
- `iteration`: `2026-09-06.21`
- `started_at`: `2026-09-04 America/Sao_Paulo`
- `heartbeat_at`: `2026-09-06T22:53:20-03:00`
- `last_progress_at`: `2026-09-06T22:53:20-03:00`
- `branch`: `codex/m81-signout-browser-e2e`
- `head`: `ac4860e` (ponta funcional; documentação posterior não altera a implementação)
- `harness_upstream_pin`: `6c705be1ce6774a000d061da41d1823b03a3d42c`

## Critérios de aceite

- nenhum blocker interno, CRITICAL ou HIGH conhecido;
- M3, M4 e M5 compostos sobre a principal após auditoria independente;
- M6 Windows e M6.1 portabilidade/imagem implementados e provados no ambiente disponível;
- gates de tipo, build, testes, i18n, domínios, licenças e artefatos aprovados em base limpa;
- estados externos continuam honestos: celular físico, cinco leigos, piloto, SMTP real e release público não são simulados;
- upstream preservado e nenhum push, PR, deploy, segredo ou exclusão não autorizada.

## Progresso comprovado

- Trust plane, Postgres P31-A, agentes/rotas e Prompt-to-App fatias 1/2 integrados.
- M1 preview seguro e M2 categorias/Golden Set incorporados na história principal.
- Recuperação de geração, limites do builder e governador de jobs/builds integrados até `d819314`.
- Bundle transportável `outputs/CODEX_BASE_d819314.bundle` verificado, SHA-256 `413EBE67B82BB0CF9A9169CAD0FB4B48CE2C91BFD58B539D3E7415A763F836BE`.
- Shell M6 Windows fechado em `fd2d84a`: lifecycle WSL2, rollback, timeouts com encerramento da árvore, health obrigatório, TLS pelo hostname público e inventário fail-closed de contêineres, volumes e redes receberam GO independente. A instalação real com imagens do produto continua `NOT_EXECUTED`.
- Pin portátil do upstream e lock da cadeia de imagens foram registrados em `80d2dd7`; pin passou em clone WSL/ext4 e a verificação on-line dos digests passou.
- O verificador do pin recebeu cinco fixtures negativas reais em `bddf0ff`
  (tracked, untracked, `.gitmodules`, manifesto e origin) e uma verificação
  positiva final. O checkout Windows continua inadequado para o gate normal
  por não materializar todos os symlinks; a prova canônica permanece WSL/ext4.
- M71 consolidou a sessão real e governada do Assistente em `646c47b`: HTTP,
  identidade, CSRF, retomada, approval e turno determinístico passaram; um
  segundo turno usou Ollama local real e o handoff foi exercitado no Edge.
- M76 registrou os trust stores do Windows e WSL2 antes/depois sem alteração
  (149 certificados Windows e 364 entradas WSL, zero diferenças). A auditoria
  de segurança do coletor e comparador fechou com zero achados.
- M76 encontrou que a desinstalação comum deixava um estado impossível de
  reinstalar. `0987206` remove os dois ponteiros operacionais após validação,
  preserva releases/estado/volumes e prova a reinstalação com o sentinela de
  dados intacto. A suíte Windows cumulativa passou 17/17 e a segunda auditoria
  de segurança fechou com zero achados.
- M77 preparou o executor do lifecycle real em 17 fases auditáveis. O dry-run
  não tem efeitos, o ambiente precisa estar vazio, três origens e quatro
  imagens são validadas antes de instalar, um sentinela PostgreSQL prova
  persistência e o trust store é comparado antes/depois.
- A auditoria inicial do M77 encontrou que o gancho de teste podia emitir
  `PASS` sem executar o lifecycle. `78e8045` separa a simulação como
  `SIMULATED_PASS`; o scan de verificação fechou com zero achados e a suíte
  Windows cumulativa passou 18/18. O lifecycle real continua `NOT_EXECUTED`.
- M78 adicionou um gate somente leitura para a evidência real do M77: estado,
  17 fases, commits, hashes, snapshots e trust store são validados antes de
  emitir o único token de release. O scan inicial encontrou que hashes
  autodeclarados permitiam forjar o pacote inteiro; `56fd26f` passa a exigir o
  SHA-256 final do relatório por canal externo antes do parse. A verificação de
  segurança fechou com zero achados e a suíte Windows passou 23/23. O lifecycle
  real continua `NOT_EXECUTED`.
- M79 corrigiu a ordem impossível do primeiro uso: o pin é provado antes da
  conversão, symlinks são promovidos de forma transacional e `core.worktree`
  só é normalizado sob invariantes estritos. A falha Windows preservou o
  placeholder; um clone novo WSL2/ext4 passou builds, typecheck e 2.027 testes
  raiz. O scan de segurança fechou com cobertura completa e zero achado.
- M80 adicionou saída autenticada e protegida por CSRF da sessão atual. A
  revogação do servidor precede cookies, cache, chaves DZ23 e redirecionamento;
  falhas não fingem sucesso. Identidade 16/16, recorte saída/PWA 8/8 e app
  60/60 passaram. O scan `377b88f6-552e-446a-9f4e-cd7687c59385` cobriu 8/8
  superfícies e terminou com zero achado. PostgreSQL físico, Docker, navegador
  E2E e celular seguem `NOT_EXECUTED`.
- M81 fechou os limites alcançáveis da M80: cookie ausente/revogado pode ser
  apagado pelo caminho exato liberado no Caddy sem remover segredo da borda,
  Host, Origin ou CSRF da sessão ativa; modo pessoal não mostra **Sair**; e a
  prévia recusa o próximo pedido após revogação da sessão de origem. Chromium
  3/3, aplicativo 63/63, identidade+prévia 76/76, handler HTTP com 100% de
  cobertura, builds/typecheck/gates limpos e scan
  `781b183b-a00b-4c09-9e76-2be9a266b84e` com zero achado. Caddy/Docker real e
  celular físico seguem `NOT_EXECUTED`.
- Claude entregou M3+M4+M5 em `9034a85`; transporte íntegro, mas ainda baseado em `b95d23c`. A composição sobre `d819314` foi solicitada novamente com evidência do merge-base.
- Preview recebeu o checkpoint isolado `7273b38`: instalação offline com lock congelado, 178/178 testes e build passaram em WSL/ext4. A prova de ausência usa `previewId`, portanto uma troca de `runtimeRef` não libera capacidade prematuramente.
- Retenção fail-closed foi fechada em `011f118`: nenhuma remoção física de artefatos na v1, 28/28 testes executados, 2 skips explícitos e 21/21 no namespace Linux com bind mounts reais.
- Backend PostgreSQL de capacidade foi fechado em `d243c02`: relógio do banco, bundles atômicos, quotas, fence monotônico e takeover CAS; PostgreSQL 16 descartável passou 11/11, build e lock congelado.
- Wiring PostgreSQL do Preview está isolado em `64e9686`: takeover no recovery,
  quarentena persistente no segundo reinício e bloqueio de HTTP antes do
  reconcile passaram revisão independente; 212 testes/2 skips e recorte 60/60.
  Single-active = GO; active-active = `NOT_IMPLEMENTED`.

## Tarefas atuais e propriedade de arquivos

- `preview capacity`: candidato isolado `64e9686` recebeu GO independente;
  integração aguarda M3–M5 por tocar o mesmo `storage-postgres/src/index.ts`.
- `retention`: fechado em `011f118` com GO independente; backend por descritor continua pré-requisito para qualquer remoção física futura.
- `M6 Windows shell`: fechado em `fd2d84a` com GO independente; lifecycle Docker Desktop real permanece `NOT_EXECUTED` enquanto a imagem M6.1 não existir.
- `M3+M4+M5`: Claude continua responsável pela ponta sobre `d819314`; Codex abriu recomposição de contingência em worktree isolado porque o inbox ainda não publicou o bundle corrigido.
- `integration/M6.1`: o self-test do pin está integrado; manifests/locks,
  runtime agregador, imagens finais, SBOM e proveniência aguardam a integração
  M3–M5 para uma única regeneração do lock.

## Testes e auditorias atuais

- preview runtime-absence: auditoria independente encontrou dois casos de troca de runtime; corrigidos e retestados, 178/178 + build + instalação offline congelada PASS. Preview distribuído ainda `NO-GO`.
- retention quarto corte: auditoria independente = `GO`; nenhuma operação física de artefato permanece ativa, e os estados projetados não são apresentados como exclusão real.
- capacity PostgreSQL: auditoria independente encontrou rollback da expiração no takeover; corrigido e reprovado em PostgreSQL 16 real, 11/11.
- M6 shell final: suíte PowerShell+Bash+Docker isolado passou; auditoria detectou e a correção fechou bypass TLS, erro de inventário mascarável e uninstall incompleto para redes/homônimos. Revisão final independente = GO.
- M3+M4+M5: a recomposição sobre `d819314` fechou os 23 domínios e 35/35 em
  PostgreSQL real; cobertura ampliada ainda precisa satisfazer D30 antes de
  auditoria e integração.
- tentativa de materializar dependências no Windows falhou com `EACCES` em links absolutos para WSL; M6.1 deve eliminar essa não portabilidade em base limpa, sem tratar o verde antigo como prova.

## Bloqueadores externos que não param o restante

- licença open source exata e política de marca;
- destino do remoto;
- SMTP real;
- domínio/Tailscale e celular físico;
- cinco participantes leigos e piloto.

## Próxima ação

1. Claude revisar M74-A, M75, M76, M77, M78, M79, M80 e M81 sem sobreposição de arquivos;
2. manter M74-B parado até GO explícito de M74-A e não tocar na M72 de Claude;
3. Claude revisar somente leitura o M77; a execução real fica aguardando
   imagens finais e autorização explícita para Docker;
4. Claude revisar somente leitura o M78 (`6d88639..e1d8134`) e o M79
   (`e1d8134..0199f13`), incluindo a âncora externa do relatório M78 e a
   transação de symlink/configuração Git do M79; nenhuma execução real é
   autorizada por isso;
5. integrar por commits verificáveis somente após parecer independente, sem
   aceitar exclusões de `plugins/*/lib/**`;
6. rodar gates completos serializados em WSL/ext4 e auditoria final independente;
7. executar o lifecycle Windows real com as imagens produzidas quando o Docker
   for explicitamente autorizado.

## Instruções de retomada

Executar `git status`, `git rev-parse HEAD`, ler este arquivo e os finais de
`outputs/CODEX_OUTBOX.md`, `outputs/CLAUDE_INBOX.md` e
`outputs/HANDOFF_CODEX_CLAUDE.md`. Não resetar a árvore compartilhada. Consultar
os agentes vivos antes de editar `plugins/preview/**`,
`plugins/runtime-governor/**`, `deploy/windows/**` ou `tests/m6/**`.
