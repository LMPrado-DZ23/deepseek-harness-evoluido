# Estado da missão autônoma DZ23 STUDIO

- Missão: `M1-M6`
- Estado: `EXECUTING`
- Etapa atual: `M1 — P34 preview seguro`
- Branch: `codex/missao-m1-preview`
- Base imutável: `ec92f29f7398d1ac69dc6201e5fb8e6bccfa60b9`
- Harness upstream preservado: `6c705be1ce6774a000d061da41d1823b03a3d42c`
- Último checkpoint: `2026-09-04 America/Sao_Paulo`

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

- [x] M1 — checkpoint de código P34 fechado; aguardando parecer independente do Claude antes de integração
- [ ] M2 — Prompt-to-App fatia 3, SaaS/dashboard e golden 18/18
- [ ] M3 — Postgres operacional, migração e backup/restore
- [ ] M4 — PWA e preparação móvel
- [ ] M5 — Integration Hub, SMTP configurável e download de protótipo
- [ ] M6 — gate Windows integrado

## Checkpoint atual

- Supervisor Docker e proxy mínimo construídos com autoridade derivada no
  servidor, sockets Unix, runtime em `NetworkMode=none`, proxy somente no
  loopback compartilhado, artefato imutável e cleanup idempotente.
- Lifecycle tenant-aware liga somente run `PASSED` ao artefato materializado,
  serializa start/stop/admissão, exige readiness e mantém cleanup incompleto em
  estado bloqueante e observável.
- Gateway fecha método, host, cabeçalhos e corpo; ticket entra somente por
  `postMessage`; respostas Unix acima do limite são recusadas sem exceção não
  tratada no stream.
- Prova física final no digest `sha256:0de6fc8f…97ff2`: runtime e proxy reais
  endurecidos, apenas `lo`, zero rotas externas, host/metadata/egress bloqueados,
  login local e cleanup sem sobreviventes. Caddy atual e Compose combinados
  validados offline.
- Chromium em contêiner sem rede: 3/3 jornadas `PASS`, incluindo login HTTP
  local, ticket fora da URL, cookie host-only, ataque por cookie duplicado,
  iframe, código local e encerramento.
- Domínios locais corrigidos para `studio.dz23.localhost` e
  `p-<id>.dz23.localhost`; origens permanecem isoladas e o cookie
  `SameSite=Strict` funciona no iframe sem CA/TLS/hosts.
- Gates em WSL/ext4: typecheck, builds, i18n (265 chaves), escopo de domínios,
  Caddy, Compose e `git diff --check` aprovados. Suíte global: 659 aprovados e
  18 integrações Postgres puladas; cobertura 94,24/90,04/95,44/97,11%. Revisão
  adversarial independente: `GO`, sem incompatibilidade concreta remanescente;
  validação focada independente 79/79 `PASS`.
- M1 autoriza `PREVIEW_OK` somente para o protótipo local verificado. HTTPS,
  celular, Tailscale, operação prolongada e experiência leiga continuam sem prova.

## Achado reservado para M3

O Claude verificou que os oito domínios Prompt-to-App não estão roteados para
PostgreSQL em `deploy/harness/edge.patch.yml`; `studio_design_specs` também não
está no patch de prova e a lista do script de runtime está desatualizada. M3
deve gerar/verificar rotas a partir de `scripts/studio-domain-specs.ts` e falhar
se qualquer domínio Studio cair no backend JSON em produção.

## Próxima ação exata

Fechar commit e artefato do M1, executar P37 sobre o arquivo extraído e entregar
ao Claude para revisão/reexecução independente. Em seguida iniciar M2 em branch
empilhada, sem integrar M1 na branch principal antes do parecer.

## Bloqueios externos reservados ao usuário

- Escolha final da licença open source e política de marca.
- Local do remoto privado.
- SMTP real, retenção da pesquisa e recrutamento das cinco pessoas leigas.
