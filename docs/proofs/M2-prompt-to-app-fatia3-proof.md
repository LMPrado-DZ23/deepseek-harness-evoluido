# M2 — Prompt-to-App fatia 3 e Golden Set final

Data: 04/09/2026. Branch: `codex/missao-m2-prompt-to-app-final`. Base
empilhada: `codex/missao-m1-preview@490a1d4`. Código provado no commit
`0bf62fef8fcb0a93e16e9872231e4c4500821d70`. O Harness upstream permanece
preservado em `6c705be1ce6774a000d061da41d1823b03a3d42c`.

## Construído

- sete categorias visíveis e honestamente classificadas como BETA:
  apresentação, catálogo, formulário com banco, painel CRUD, agendamento,
  dashboard e área autenticada;
- geradores determinísticos para dashboard, agenda e SaaS autenticado, com
  organização, tenant, papel e propriedade derivados da sessão do servidor;
- agenda com estado controlado pelo sistema, autorização por papel, isolamento
  por proprietário, índice parcial único por data/horário ativo e conflito
  traduzido para `SLOT_ALREADY_RESERVED` no driver `node:sqlite` real;
- área autenticada com registros ligados ao usuário, ações somente no servidor,
  validação de entrada e confirmação explícita de exclusão;
- política de importação que impede o modelo de acessar rede, runtime ativo,
  módulos privilegiados, globals perigosos, storage do navegador, componentes
  dinâmicos, caminhos determinísticos ou arquivos fora do plano aprovado;
- scan do AppSpec, da saída do modelo e dos arquivos de framework, antes da
  materialização do artefato;
- Golden Set com schema estrito, IDs e hashes únicos e separação explícita
  entre checks técnicos e critérios de negócio não automatizados.

## Provas executadas

Ambiente canônico: clone limpo em ext4 no WSL2, Node 22.23.1, pnpm 11.7.0 e
Docker Desktop. A árvore estava limpa antes de o runner produzir o relatório.

- `pnpm typecheck`: `PASS`;
- `pnpm -r build`: `PASS`, 12 pacotes aplicáveis;
- Vitest com cobertura: 725 testes `PASS`; 18 integrações PostgreSQL
  `SKIPPED` porque o serviço não foi configurado nesta prova;
- cobertura global: 94,36% statements, 90,02% branches, 95,80% functions e
  97,10% lines;
- identidade, policy, tenancy, agents/route-health e controles críticos de
  importação/segurança do Prompt-to-App: 100% nas quatro métricas aplicáveis;
- interface: 5/5 testes `PASS`;
- i18n: `PASS`, catálogo pt-BR com 277 chaves;
- escopo de domínios: `PASS`, sem wildcard;
- Golden Set: 18/18 pipelines técnicos verificados em contêineres sem rede,
  184 checks técnicos aprovados, zero categoria `NOT_IMPLEMENTED`;
- critérios de negócio: zero promovidos automaticamente e 54 corretamente
  mantidos como `NOT_AUTOMATED`;
- LLM real: `NOT_EXECUTED`;
- imagem canônica do builder:
  `sha256:81080d0031aeeeb9d4ea8fd4bc44f90473cd4adc9e3bebf9643361355554ed2b`;
- SHA-256 conjunto das fixtures:
  `138519ea67b15015511813f15069c6406d0330936cb146744bb59c0b564d4bdf`;
- relatório JSON:
  `C8247E3BA4507BE704F8A7B5EFD110B91F95CB9285C0B1BA4CB9902081C7E936`;
- relatório Markdown:
  `80A55822853DC2C170E7B18AFB7120B1D2782C664F640648BD9DC48190790FB3`.

## Falhas reais encontradas e fechadas pelo Golden Set

1. Os repositórios gerados usavam parameter properties TypeScript, recusadas
   pelo modo strip-only do Node 22. Foram substituídas por campos e
   construtores compatíveis, com regressões para dados, agenda e SaaS.
2. O conflito de horário era protegido pelo SQLite, mas o driver retornava
   `ERR_SQLITE_ERROR` em vez de `SQLITE_CONSTRAINT`. A classificação agora
   reconhece apenas a violação única das colunas de data e horário e preserva
   os demais erros como falha técnica.

## Limites verdadeiros

- PostgreSQL real e migração/backup/restore pertencem ao M3; esta prova não os
  substitui;
- LLM, SMTP, passkey, domínio público, HTTPS/ACME, celular físico e deploy:
  `NOT_EXECUTED` ou `NOT_CONFIGURED`;
- os 54 critérios de negócio declarados precisam de automação adicional ou
  aceite humano; o gate não os chama de aprovados;
- experiência para pessoas leigas: `NOT_VALIDATED` até a fase 0.5;
- semântica HTTP 404 da área autenticada, mitigação de timing na descoberta de
  conta e quota/paginação SaaS permanecem no backlog antes de release público.

## Veredito honesto

M2 fecha a implementação técnica das sete categorias em estado `BETA` e prova
o pipeline determinístico completo. Não promove o produto, não afirma aceite
integral dos briefs e não autoriza publicação. O merge na branch principal
depende de parecer independente do Claude sobre este checkpoint.
