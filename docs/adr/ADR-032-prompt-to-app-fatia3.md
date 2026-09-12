# ADR-032 — Prompt-to-App fatia 3

- Estado: Aceita
- Data: 2026-09-04
- Ressalva: para checkpoint tecnico BETA; nao validada com pessoas leigas e sem autorizacao de publicacao

## Decisão

O DZ23 STUDIO oferece três capacidades adicionais, todas compostas sobre os
contratos existentes de AppSpec, autenticação, SQLite e verificação:

1. **Agenda interna:** membro consulta e cancela somente os próprios horários;
   proprietário consulta todos e confirma; colisão e data passada são recusadas
   no servidor.
2. **Dashboard:** somente leitura, alimentado pelo repositório gerado; resumo,
   tabela e gráfico derivam da mesma coleção. Nenhuma métrica financeira ou
   interpretação de negócio é inventada.
3. **Área autenticada mínima:** `owner_user_id` vem exclusivamente da sessão;
   membro vê seus registros e proprietário vê todos; mutações têm CSRF, limites
   de entrada e resposta 404 equivalente para ausente ou pertencente a outro
   membro.

Arquivos de framework são determinísticos e protegidos. A saída do modelo é
declarativa: não pode criar ações, executar chamadas, acessar rede/runtime,
usar componentes dinâmicos, escrever nos caminhos reservados do Studio ou
alterar arquivos fora do plano aprovado. Toda a união de arquivos é examinada
antes do build isolado sem rede.

## Limites honestos

- Agenda é interna à equipe e ainda usa data UTC no protótipo; timezone é
  requisito anterior à produção.
- Dashboard genérico conta e agrupa registros, mas não calcula dinheiro,
  atraso ou outros conceitos sem contrato de domínio.
- Área autenticada não inclui documentos, família/responsável nem campos
  bancários.
- A resposta e o cookie do pedido de código não revelam se o e-mail existe,
  mas a entrega ainda é síncrona e pode diferir em tempo; fila assíncrona ou
  equalização temporal comprovada é gate anterior à exposição pública.
- A área autenticada limita cada payload, mas ainda precisa de quota, rate
  limit e paginação por cursor antes de uso público ou volume prolongado.
- `NOT_FOUND` entre membros é semanticamente indistinguível no repositório;
  não se afirma HTTP 404 até uma rota HTTP exercitar esse contrato.
- LLM real, jornada integrada de preview, Windows e cinco pessoas leigas ainda
  não foram executados nesta fatia.
- Golden técnico verde não equivale a atendimento integral de todos os
  critérios textuais. Cada critério não provado permanece `NOT_AUTOMATED`.

## Consequências

As capacidades entram na matriz como `BETA`, nunca como aplicação pronta. Uma
mudança de autoridade, escopo por membro ou caminho protegido exige nova prova
adversarial e revisão independente antes de integração.
