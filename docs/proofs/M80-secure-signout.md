# M80 — saída segura da sessão atual

Data: 2026-09-06

## Resultado

Estado: **GO no recorte M80**, ainda **BETA no produto**.

O DZ23 STUDIO ganhou um botão **Sair** que não confunde limpeza local com
revogação real. O navegador envia `POST /api/studio/identity/logout` com o
cookie HttpOnly da sessão e o CSRF daquela sessão. A borda mantém a rota atrás
de `forward_auth`; o serviço revoga exatamente o `session_id` autenticado,
nunca recebe do cliente qual sessão deve revogar e nunca usa a operação de
revogar todos os dispositivos. Cookies são expirados e `signed_out: true` só é
emitido depois de `revokeSession` terminar.

O cliente só apaga a casca PWA, o CSRF de `sessionStorage` e a seleção da
sessão do Assistente em `localStorage` depois dessa prova. O redirecionamento é
fixo em `/login`. Uma falha do servidor mantém a tela e o estado local e mostra
erro; uma falha do navegador depois da revogação não recupera autoridade.

## Identidade da mudança

- branch: `codex/m80-secure-signout`
- base: `d85cc87940f675d4c74d0bb2f77f809c689b0c98`
- commit funcional: `fb88dd3b3db1bd229ef8367115c7ce542113fdf3`
- upstream fixado: `deepseek-harness@6c705be1ce6774a000d061da41d1823b03a3d42c`
- bundle de teste: `outputs/M80_TEST_fb88dd3.bundle`
- SHA-256 do bundle: `CAD8538AF8ED00A8E00AB40C23421C2923458116DE083ECD58DAE906E11E3EB1`

## Provas executadas

Em clone limpo no ext4 do WSL2:

- bootstrap do upstream e symlink real: PASS;
- `pnpm install --frozen-lockfile` e `pnpm build:official` do Harness: PASS;
- instalação congelada dos pacotes Studio: PASS;
- build completo do Studio: PASS;
- typecheck: PASS;
- gates i18n, portabilidade, domínios e pin upstream: PASS;
- identidade HTTP: 16/16 testes PASS;
- saída + origem da casca PWA: 8/8 testes PASS;
- suíte completa do aplicativo web: 60/60 testes PASS.

A suíte raiz integral não ficou verde neste recorte. Na repetição mais estável,
2.028 testes passaram, 62 foram pulados e um teste não relacionado da
`builder-supervisor` excedeu seu timeout fixo de 5 s sob carga. O arquivo
inteiro depois passou isolado 52/52. Isso é registrado como baseline de
ambiente conhecido, não como prova de suíte integral verde. A M79 na base
cumulativa havia passado 2.027 testes raiz.

## Auditoria de segurança

- scan: `377b88f6-552e-446a-9f4e-cd7687c59385`
- faixa: `d85cc87940f675d4c74d0bb2f77f809c689b0c98..fb88dd3b3db1bd229ef8367115c7ce542113fdf3`
- cobertura: completa no diff, 8/8 superfícies revisadas;
- resultado: **0 candidatos reportáveis e 0 achados confirmados**;
- relatório: `C:/Users/zodyp/.codex/security-scans/m80-secure-signout/fb88dd3b3db1bd229ef8367115c7ce542113fdf3_20260906T230149Z_sx3b6gd3/report.md`.

A revisão independente confirmou os controles e registrou limitações sem
demonstrar ganho de privilégio: persistência da revogação e auditoria são duas
escritas sequenciais; um cookie já revogado não alcança a limpeza idempotente;
outra aba pode manter estado visual em memória, embora a autoridade no servidor
já esteja revogada; e `/login` foi provado na implantação Caddy, não no modo
pessoal direto em loopback.

## Não executado e pendências honestas

- PostgreSQL físico e atomicidade revogação+auditoria: `NOT_EXECUTED`;
- Caddy/Docker real nesta etapa: `NOT_EXECUTED`;
- jornada E2E em navegador e celular físico: `NOT_EXECUTED`;
- saída idempotente de sessão já revogada: backlog;
- encerramento automático de prévia ativa no logout: não implementado; a
  prévia conserva seu ticket e TTL independentes;
- TAC consultivo do scanner: indisponível porque o conector não estava ligado.

Nenhum merge na principal, push, PR ou deploy foi realizado por esta prova.
