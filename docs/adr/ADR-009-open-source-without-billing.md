# ADR-009 — Produto open source sem cobrança

- Status: Decisão de produto aceita; licença jurídica exata pendente
- Data: 2026-09-02
- Decisor: proprietário do DZ23 STUDIO

## Decisão

O DZ23 STUDIO será open source e não terá cobrança, assinatura, plano pago,
créditos, paywall, comissão ou bloqueio de capacidade por pagamento. Identidade,
organização e papéis existem para segurança e colaboração, não para faturamento.

Consequentemente:

- `owner` não possui responsabilidade de billing;
- nenhuma fase deve introduzir Stripe, checkout, medição faturável ou tela de
  upgrade;
- integrações externas eventualmente pagas são contratadas diretamente pela
  pessoa usuária e configuradas por BYOK, sem cobrança pelo Studio;
- contribuições e plugins continuam sujeitos a assinatura, permissões e
  auditoria de cadeia de suprimentos.

## Pendência jurídica

O arquivo `LICENSE.md` ainda registra o estado proprietário anterior. Isso não
pode ser silenciosamente convertido sem escolher a licença. Antes de publicar,
o proprietário deve escolher uma licença OSI. Recomendação técnica: Apache-2.0
para adoção ampla e cláusula expressa de patentes; alternativa: AGPL-3.0-only se
for obrigatório publicar modificações oferecidas como serviço.

Até essa escolha ser registrada e `LICENSE.md` substituído, o repositório não
deve ser divulgado como legalmente redistribuível, embora a direção de produto
open source e sem cobrança já esteja congelada.
