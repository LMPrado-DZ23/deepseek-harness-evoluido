# Estado da missão autônoma DZ23 STUDIO

- Missão: `M1-M6`
- Estado: `EXECUTING`
- Etapa atual: `M1 — P34 preview seguro`
- Branch: `codex/missao-m1-preview`
- Base imutável: `ec92f29f7398d1ac69dc6201e5fb8e6bccfa60b9`
- Harness upstream preservado: `6c705be1ce6774a000d061da41d1823b03a3d42c`
- Último checkpoint: `2026-09-03 America/Sao_Paulo`

## Objetivo

Entregar, em branches empilhadas e sem push/deploy, as etapas M1 a M6: preview seguro, categorias finais do Prompt-to-App, Postgres operacional, PWA móvel, Integration Hub/download e gate Windows.

## Concluído antes desta missão

- Trust plane v1 integrado.
- `storage-postgres` P31-A integrado em estado BETA.
- Composição de agentes e rotas da fase 3 integrada.
- Prompt-to-App fatias 1 e 2 integradas no commit ancestral `58f77d3`.
- Branch histórica `codex/p32-fatia2-prompt-to-app` restaurada em `58f77d3` após ter sido removida sem autorização.

## Regras vinculantes

- Não editar o Harness upstream.
- Não instalar CA raiz, alterar trust store/hosts, ativar MITM/TPROXY ou liberar egress do preview.
- Não excluir branch ou worktree sem autorização expressa do Prado.
- Não fazer push, PR, deploy, piloto ou release público.
- Só o Codex integra; cada etapa aguarda parecer independente do Claude antes de merge na branch principal.
- Subagentes ficam limitados a auditoria, revisão, testes, provas e documentação, com propriedade exclusiva de arquivos.
- Capability states permanecem honestos (`BETA`, `NOT_EXECUTED`, `NOT_VALIDATED`, etc.).
- Divisão conjunta: Codex constrói M1-M6; Claude não implementa os mesmos
  pacotes, revisa os checkpoints e reexecuta os gates em ambiente independente.

## Etapas

- [ ] M1 — P34 preview seguro
- [ ] M2 — Prompt-to-App fatia 3, SaaS/dashboard e golden 18/18
- [ ] M3 — Postgres operacional, migração e backup/restore
- [ ] M4 — PWA e preparação móvel
- [ ] M5 — Integration Hub, SMTP configurável e download de protótipo
- [ ] M6 — gate Windows integrado

## Checkpoint atual

- P34-A concluído em `302b582`: análise AST recusa `use server` aninhado e
  APIs de rede executáveis sem confundir textos ou comentários.
- Núcleo P34 concluído em `c861fc3` e ajuste de tipagem de prova em `76ebca0`:
  domínio tenant-aware, hash integral do artefato, lifecycle, TTL, mutexes,
  reconciliação, admissão opaca, gateway com allowlist e fail-closed.
- Jornada visual local concluída em `068a212`: iframe isolado, ticket entregue
  por `postMessage`, aviso permanente de não publicação, códigos
  `studio-preview` e encerramento pela pessoa.
- Revisão adversarial do núcleo: `GO`, sem achado ALTO/MÉDIO. Residual: o
  supervisor real deve provar que respeita `AbortSignal` e não deixa runtime
  órfão após timeout.
- Gates em WSL/ext4: typecheck `PASS`; 64 testes focados `PASS`; i18n 208 chaves
  `PASS`; domínios `PASS`; builds `PASS`. A suíte Playwright iniciou, mas o
  navegador não abriu por bibliotecas nativas ausentes no host; não é prova E2E.
- Docker Desktop está indisponível. Supervisor Docker, rede interna sem egress,
  Caddy real e jornada completa de navegador permanecem `NOT_EXECUTED`.
- M1 ainda não pode receber `PREVIEW_OK`; o runtime padrão é
  `UnconfiguredRuntime` e recusa iniciar a prévia.

## Achado reservado para M3

O Claude verificou que os oito domínios Prompt-to-App não estão roteados para
PostgreSQL em `deploy/harness/edge.patch.yml`; `studio_design_specs` também não
está no patch de prova e a lista do script de runtime está desatualizada. M3
deve gerar/verificar rotas a partir de `scripts/studio-domain-specs.ts` e falhar
se qualquer domínio Studio cair no backend JSON em produção.

## Próxima ação exata

Entregar este checkpoint ao Claude para revisão e reexecução independente.
Em paralelo seguro, preparar o supervisor Docker/Caddy sem afirmar execução;
o gate real exige daemon Docker disponível e navegador funcional.

## Bloqueios externos reservados ao usuário

- Escolha final da licença open source e política de marca.
- Local do remoto privado.
- SMTP real, retenção da pesquisa e recrutamento das cinco pessoas leigas.
