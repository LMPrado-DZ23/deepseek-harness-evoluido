# M82 — saída segura sincronizada entre abas

Data: 2026-09-07

## Resultado

Estado: **GO no recorte M82**, ainda **BETA no produto**.

Uma saída confirmada pelo servidor agora alcança todas as telas abertas do
Studio — Início, Hub e Assistente — sem repetir a mutação de logout. Cada aba
recebe um sinal fechado e sem dados pessoais por `BroadcastChannel`, com
`localStorage` como transporte alternativo, consulta duas vezes a sessão
autoritativa e só então limpa o estado DZ23 e segue para `/login`.

Uma autenticação legítima concluída enquanto a segunda consulta antiga estava
em voo é preservada. O marcador usado para reconhecer esse caso é um nonce de
128 bits sem autoridade, retornado por magic link ou passkey e gravado no
`localStorage` da origem do Studio. Ele não é cookie, token de sessão nem fonte
de autorização.

## Identidade da mudança

- branch: `codex/m82-cross-tab-signout`;
- base: `d5ff3b3c83585e93d4b7ddee210ed8bc0106ef5c`;
- implementação inicial: `1fa738b6de238d3ba02ecd92f980708d56c92101`;
- cobertura global e segunda consulta: `faccc8e58ef63b20b95875a9faa70c5a29347e61`;
- primeiro marcador de login: `bcadfeb0575de84f9f4771beb50b7dc538d0003c`;
- isolamento final da origem: `2056fb03de1b89042a220711cef6d614aa8676fe`;
- upstream fixado: `deepseek-harness@6c705be1ce6774a000d061da41d1823b03a3d42c`.

## Revisões adversariais

A revisão independente encontrou três defeitos antes do fechamento:

1. Hub e Assistente estavam fora do listener global;
2. uma resposta antiga poderia limpar uma autenticação nova;
3. uma prévia não confiável podia plantar um cookie `Domain=dz23.localhost` e
   alterar o marcador que decidia preservar a tela.

Os três foram corrigidos. A geração saiu por completo do cookie e passou para
armazenamento isolado por origem. O teste adversarial abre uma origem de
prévia, planta e rotaciona o cookie de domínio pai durante a consulta final e
prova que a aba do Assistente ainda limpa o CSRF e segue para `/login`. A
quarta revisão independente em `d5ff3b3..2056fb0` concluiu **GO**, com
`diff --check` aprovado e sem regressão concreta de autenticação, CSRF,
cookies duplicados ou comportamento fail-closed.

## Provas executadas

- aplicativo web: 72/72 testes PASS;
- identidade HTTP: 20/20 testes PASS;
- build de produção do aplicativo, service worker e identidade: PASS;
- typecheck agregado: PASS;
- gates de i18n, portabilidade, escopo e rotas de domínio e pin upstream: PASS;
- Chromium real: PASS para saída em Início/Hub/Assistente, ausência de segunda
  mutação, falha preservando estado, autenticação nova durante consulta final e
  cookie de prévia incapaz de suprimir a limpeza;
- servidores de teste encerrados depois da prova.

O runner canônico Playwright 1.50.1 não iniciou porque o cache offline
disponível está internamente inconsistente: falta ou não é exportado
`playwright-core/lib/bootstrap`. Estado: `BLOCKED_ENVIRONMENT`. A prova
alternativa usou Playwright 1.62.1 já instalado para controlar Chrome real e
não é apresentada como execução da suíte canônica.

## Auditoria de segurança

- scan final: `14ad9210-23d6-42d4-a411-0a13800496b3`;
- faixa imutável: `d5ff3b3c83585e93d4b7ddee210ed8bc0106ef5c..2056fb03de1b89042a220711cef6d614aa8676fe`;
- nove superfícies de produção contabilizadas e fechadas;
- resultado: **0 candidatos reportáveis e 0 achados confirmados**;
- relatório: `C:/Users/<voce>/.codex/security-scans/m82-cross-tab-signout/2056fb03de1b89042a220711cef6d614aa8676fe_20260907T041943Z_8spga1jz/report.md`.

O TAC consultivo não estava conectado e não bloqueou a varredura.

## Limites verdadeiros

Caddy/Docker real, domínio/ACME, PostgreSQL físico multi-instância, celular e
deploy não foram executados nesta etapa. Uma falha de `localStorage` não amplia
autoridade: as duas consultas ao servidor continuam sendo a fonte da verdade.
O nonce permanece até o próximo login porque removê-lo durante o logout criaria
uma corrida entre abas; ele não autentica nenhuma requisição.

Nenhum merge na principal, push, PR, deploy ou comando Docker foi realizado.
