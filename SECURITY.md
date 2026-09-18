# Política de segurança

## Relatar uma vulnerabilidade

**Não abra uma *issue* pública.** Use o canal privado do GitHub:

> **Security** → **Report a vulnerability**
> https://github.com/LMPrado-DZ23/deepseek-harness-evoluido/security/advisories/new

Responderemos o recebimento em até **5 dias úteis**. Este é um projeto mantido
por uma equipe pequena; se o prazo passar, um *issue* público dizendo apenas
"enviei um relato privado, sem resposta" (sem detalhe técnico) é legítimo.

O que ajuda no relato: versão ou *commit*, o que você conseguiu fazer, o que
deveria ter acontecido, e o caminho mínimo para reproduzir.

## Escopo

O FRIGG **executa código gerado por modelo** e **constrói projetos de
terceiros**. As fronteiras que mais nos interessam:

| fronteira | o que deveria valer |
|---|---|
| contêiner de construção | sem rede, raiz somente leitura, sem capacidade, sem privilégio |
| prévia | host próprio, código de admissão, **sem** herdar sessão do Studio |
| níveis de política | T2 exige confirmação; T3 exige confirmação **e** *passkey* recente |
| sessão | opaca e revogável no servidor; sair encerra de verdade |
| isolamento entre inquilinos | `org_id` + `tenant_id` em toda leitura escopada |
| borda | Caddy como entrada única, com `forward_auth` |
| geração | nenhum segredo no código gerado, no pacote ou no log |

Escapar de qualquer uma dessas é vulnerabilidade, mesmo que nenhum teste reprove.

## Fora de escopo

- Ausência de cabeçalho em resposta que não expõe dado.
- Achado de varredor automático sem caminho de exploração.
- Vulnerabilidade em dependência **já** corrigida no *upstream* e ainda não
  atualizada aqui — abra um *issue* normal.
- O submódulo `third_party/deepseek-harness`: reporte à DeepSeek. Se o problema
  for **como o Studio usa** a costura, aí é conosco.

## O que já sabemos, e está escrito

Este repositório publica os próprios limites em
[`docs/MASTER_REQUIREMENTS_LEDGER.md`](./docs/MASTER_REQUIREMENTS_LEDGER.md) e nos
relatórios de [`audit/`](./audit/). Antes de relatar, vale conferir se o
comportamento já está lá como limitação declarada — várias estão.
