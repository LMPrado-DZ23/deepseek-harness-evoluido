# Revisão independente de três auditores — OS-64 a OS-70

Conforme §19–20 da missão, o executor **não pode** declarar conclusão. Três
auditores revisaram os blocos OS-64 a OS-70 **sem ver as conclusões uns dos
outros**, com acesso somente de leitura.

- **Auditor A** — Arquitetura e Engenharia
- **Auditor B** — Segurança / DevSecOps
- **Auditor C** — Produto / QA / UX

## O achado que bloqueou tudo

**Vazamento entre inquilinos.** `PlannerEngine` é criado UMA vez por processo e
servido a todas as organizações. `lastLedger`, `lastSkills` e `lastCode` eram
campos de instância, e a rota de plano os lia **depois** do `await` de
`proposePlan`. Nessa janela outro pedido, de outra organização, já tinha
sobrescrito os três — e a resposta saía com o contexto dela: quais habilidades
de terceiro a outra empresa tem instaladas, o que foi recusado e por quê, se o
pedido dela era mudança ou criação nova.

A e B acharam de forma independente. **B reproduziu com prova de conceito.**

O mais duro: a OS-64 não criou a corrida — ela já existia. A OS-64 transformou
um campo de depuração num **canal de saída para o navegador**, com dez linhas.

Correção: `plan()` e `slice()` **devolvem** o registro. Um valor devolvido não
tem janela: ele pertence à chamada que o produziu, e a nenhuma outra.

## O padrão que os três encontraram, cada um do seu lado

> **Os comentários longos justificavam decisões que a composição desfez.**

Eles descrevem com precisão o que a função pura faz, e afirmam com a mesma voz
propriedades do sistema que a fiação não sustenta. Como este repositório pede
que se confie neles, essa divergência foi o achado mais caro — mais do que
qualquer item isolado.

Exemplos, pelos três auditores:

| o comentário afirma | a fiação fazia |
| --- | --- |
| "nada aqui é declarado pronto; o estado vem de sondagem real" | todas as sondagens carimbadas com `now`, derivadas de leitura de boot |
| "o identificador interno nunca aparece" | `integration:<id> artifact:<sha256>` escrito na tela |
| "a frase é escrita pelo próprio inventário" | a frase vinha do catálogo de tradução; traduzir apagava o aviso |
| "uma segunda chamada leria o estado do planejador depois de outro pedido" | a chamada única fazia exatamente isso, por causa do `await` no meio |
| "pixels errados viram 'a página está branca'" | filtro de PNG inválido decodificava lixo, com a guarda morta |

## Achados endereçados

| # | auditor | achado | correção |
| --- | --- | --- | --- |
| A1/B1 | A, B | vazamento entre inquilinos | `plan`/`slice` devolvem o contexto; teste de concorrência pela rota |
| A5 | A | revisão bloqueia mas o registro fica `PASSED` | o registro é reescrito como `FAILED`, sem impressão de artefato |
| A8 | A | `AttemptOutcome.stage` dizia `generate` sempre | guarda o estágio da tentativa anterior |
| A11 | A | `CONFIRMED` significava "não olhei" | veredito próprio `NOT_REVIEWED` |
| A9/A13 | A | motivo do descarte perdido; esquema na lista do que ficou de fora | `reason` atravessa; esquema filtrado das DUAS listas |
| A12/B4 | A, B | guarda de filtro PNG era código morto (`Uint8Array` guarda 255, não −1) | conferência movida para antes do laço |
| B3 | B | bomba de descompressão e dimensões sem teto (62 KB → 128 MB medidos) | `MAX_PIXELS`, `maxOutputLength`, recusa `TOO_LARGE` (que não é corrupção) |
| B5 | B | contagem de cores sem teto, com o documento afirmando um teto inexistente | `COLOR_COUNT_CEILING` |
| B2 | B | procedência interna na tela | a frase não interpola mais; a procedência fica no campo, para conferir |
| B6 | B | aviso de inventário incompleto falhava ABERTO por casar substring traduzida | booleano atravessa desde o planejador |
| B7 | B | esquema aparecia no que ficou de fora | filtrado |
| C1 | C | o aviso era pintado de cinza por acidente de especificidade | seletor corrigido + a palavra "Atenção" (cor sozinha não carrega significado) |
| C2 | C | o aviso ficava dentro de um `<details>` FECHADO, com título idêntico | o painel abre sozinho e o título muda |
| C3 | C | a ressalva que impede a tela de afirmar demais saía como "Código da falha" em `<code>` | campo `notice` próprio, renderizado em prosa |
| C4/A17 | C, A | `PROBE_STALE` virava "não dá agora" — negativa falsa 1h depois de funcionar | entrou em `UNMEASURED_REASONS`, com frase própria |
| H2 | C | `blocked_by` interpolava o id interno ao lado do nome de produto | `capabilityName` mapeia para o nome que a tela já usa |
| H3 | C | recusas de habilidade não diziam QUAL | o nome entra na frase |
| H5/H6/H7 | C | listas idênticas; 4 reprovações de contraste no escuro; transbordo em 360px | cabeçalho e marcador próprios; `--ok`/`--danger`/`--line` definidos nos dois temas; painel ancorado pela direita |
| M4/M5/M6 | C | duas causas numa frase; lista vazia silenciosa; gravidade escondida | três correções de texto |

## Achados ACEITOS e não corrigidos, com o motivo

- **A2/A3/A4** — as sondagens de capacidade derivam de leitura de estado, e não
  de exercício; `criar-aplicativo` responde "ninguém conferiu" porque ninguém
  passa a última execução. Isto está **declarado** no livro mestre desde a
  OS-67 e continua verdade. Corrigi-lo exige o `updated_at` real do
  `route-health` e um acessor global de execuções; é trabalho próprio, não
  remendo.
- **A6** — nenhum critério da revisão independente é alcançável na única chamada
  de produção, porque a atestação já fecha tudo antes. Já estava escrito no
  livro mestre da OS-66 ("a revisão é segundo muro, não primeiro") e num teste
  que diz isso com todas as letras. A revisão **não** foi removida: ela é o que
  pega a contradição no dia em que o primeiro muro mudar.
- **A14** — `visual-qa.ts` e `learning.ts` não têm consumidor. Declarado nos
  respectivos requisitos. O endurecimento de B3/B4/B5 foi feito **antes** do
  primeiro chamador de propósito: no dia em que ele existir, a entrada será um
  PNG vindo de um navegador rodando código gerado por modelo — entrada não
  confiável por construção.
- **P5** (falsificação própria) — a condição `attempt > 1` é redundante hoje. Já
  está dito no código, com o motivo.

## O que nenhum dos três conseguiu verificar

- Comportamento sob PostgreSQL real para o registro reescrito (A5).
- Leitor de tela de verdade; as afirmações de ARIA são comportamento
  documentado, não medição.
- A suíte completa e os portões: cada auditor rodou um subconjunto, por causa do
  teto de 2 minutos por comando.
