# Estado da missão autônoma — DZ23 STUDIO v1.0

- mission_id: `DZ23-STUDIO-V1-20260904`
- objetivo: concluir o DZ23 STUDIO v1.0 com runtime portátil, geração isolada, gates Windows/Linux, testes com cinco pessoas e pacote open source somente após licença escolhida
- estado: `TESTING`
- iteração: 7
- início: 2026-09-04
- último heartbeat: 2026-09-04T18:35:27-03:00
- último progresso real: fechamento dos bloqueios estáticos M6.1 de perfil gravável, conteúdo empacotado, toolchain verificada, build pós-fetch sem rede e política multiarch do builder
- tarefa atual: construir e provar a imagem runtime M6.1 a partir do staging WSL2/ext4
- branch: `codex/m61-final`
- base: `c57f914a49787de28d12141b167874357734f2d7`
- upstream: `deepseek-harness@6c705be1ce6774a000d061da41d1823b03a3d42c`
- staging válido: `/home/leandro/dz23-m61-build-20260904c`
- staging inválido preservado: `/home/leandro/dz23-m61-lock-20260904a` (origem calculada incorretamente e sincronização interrompida)

## Concluído nesta iteração

- workspace unificado sem links absolutos e lock regenerado no ext4;
- manifesto independente de Git validando 8.953 blobs, 11 symlinks e modos do upstream;
- profile de produção sem provider falso e materialização gravável versionada no `DSH_HOME`;
- UI e template Next.js empacotados no lifecycle do próprio pacote;
- usuário 10001 real, `HOME` e diretórios persistentes explícitos;
- pnpm baixado e conferido por SHA-512, SHA-256 e SHA-1;
- `pnpm install`, builds e deploy posteriores ao fetch com rede desativada;
- builder com seleção amd64/arm64 e hashes fixados;
- gate de portabilidade cobrindo arquivos não rastreados e entrypoints;
- gate de proveniência/SBOM determinístico: 6/6 testes;
- gate de imagens: 2/2 testes; portabilidade e `git diff --check`: PASS.

## Auditorias delegadas

- runtime: NO-GO inicial; achados incorporados no worktree e aguardando prova física;
- supply chain: NO-GO inicial; pnpm, rede, contexto secreto, licença falsa e manifesto corrigidos; SBOM/proveniência aguardam imagem OCI real;
- builder multiarch: desenho M6.2 definido; não montar Docker socket no Harness.

## Bloqueadores atuais

- imagem runtime ainda não construída após as correções;
- `builder-supervisor` M6.2 ainda não implementado; geração no runtime final deve permanecer `BLOCKED_EXTERNAL` até ele existir;
- prova OCI amd64/arm64, SBOM real, inspect e smoke ainda pendentes;
- licença open source exata ainda depende do Prado; sem ela não há redistribuição pública;
- gate Windows, cinco sessões leigas e piloto continuam pendentes.

## Falhas observadas

- build anterior: `@deepseek-ai/dsh-subprocess-local` não estava na allowlist de scripts; corrigido, reteste pendente;
- primeira sincronização WSL resolveu a origem incorretamente e começou a copiar `/` para staging; foi interrompida, não tocou no repositório, e um staging novo explícito foi criado;
- sincronização seguinte excluiu diretórios aninhados chamados `runtime`; o upstream ficou incompleto; a subárvore foi ressincronizada sem esse padrão e o manifesto passou.

## Próxima ação

1. criar commit local de checkpoint da M6.1;
2. construir a imagem no staging ext4 com o hash exato;
3. corrigir causa raiz de qualquer falha e repetir;
4. provar deploy, profile, UI, template, usuário, Git, readonly/caps/NNP, reinício e sinais;
5. implementar M6.2 builder-supervisor e só então fechar a jornada Prompt-to-App instalada.

## Resume instructions

Leia este arquivo, confira `git status`, `git log -3`, os processos Docker/WSL e o conteúdo de `HANDOFF_CODEX_CLAUDE.md`. Preserve todos os worktrees e stagings. Não faça push, PR, deploy público nem escolha licença em nome do Prado.
