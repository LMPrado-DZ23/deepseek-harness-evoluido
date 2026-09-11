# Blockers internos

Um blocker interno é um defeito ou lacuna que **depende só de nós**. Se depende
de credencial, hardware ou autorização de terceiro, ele é externo e mora em
`EXTERNAL_BLOCKERS.md` — e classificar um interno como externo para não
trabalhar nele é a forma mais comum de esconder trabalho.

Meta: `CRITICAL = 0` e `HIGH = 0`.

Estado em 11/09/2026: **CRITICAL = 0, HIGH = 0.**

## Abertos

| ID | severidade | componente | causa raiz | estado |
| --- | --- | --- | --- | --- |
| IB-01 | MEDIUM | `plugins/prompt-to-app` (compreensão) | O palpite de categoria acerta 42,9% num conjunto CEGO de briefs leigos (`gate:comprehension`). A defesa estrutural existe — a tela abre vazia e bloqueia "Continuar" quando o palpite não é confiável —, mas a medida é ruim e está registrada como ruim | ABERTO |
| IB-02 | MEDIUM | `scripts/check-rls-coverage.ts` | 19 de 26 domínios não têm RLS no banco. **Não são pendências**: são exclusões estruturais nomeadas na ADR-044, cada uma com citação conferida. Três (`runs`, `projects`, `approvals`) voltam a ser candidatos se a varredura de reinício for redesenhada por inquilino | ABERTO POR DESENHO |
| IB-03 | LOW | `plugins/agent-team` | O grafo de tarefas tem `depends_on` mas não tem os estados `READY`/`BLOCKED`/`REVIEW`/`DONE`; sem eles, "qual é a próxima tarefa executável" não é uma pergunta que o sistema responda sozinho | ABERTO |
| IB-04 | LOW | observabilidade | Não existe `trace_id` costurando missão → tarefa → execução de agente → chamada de ferramenta. Cada plugin tem o seu id e ninguém consegue reconstruir uma missão inteira | ABERTO |

## Fechados nesta iteração

| ID | severidade | o que era | correção |
| --- | --- | --- | --- |
| IB-05 | MEDIUM | `hasApprovedAncestor` decidia autorização só por linhagem de sessões, **sem** conferir o diretório de trabalho, e ficava exportada ao lado de `approvedGrantFor`, que confere. Ninguém chamava a insegura — o risco era o próximo leitor escolher pelo nome mais curto | removida; `approvedGrantFor` já era a única usada |
| IB-06 | LOW | `startDelegation`: porta de entrada pública para iniciar delegação, sem chamador e sem teste | removida |
| IB-07 | MEDIUM | O botão "Voltar para este ponto" aparecia para toda tentativa verde, inclusive **durante a criação**, e a recusa do servidor só chegava depois de confirmar | `UNDO_AVAILABLE_BY_STATE`, tabela exaustiva espelhando o servidor; 6 testes, 2 falsificações |
| IB-08 | MEDIUM | Duas listas negadas de categoria que precisavam concordar entre si; categoria nova caía num `return` silencioso e gerava aplicativo com formulário e sem banco | `CATEGORY_REQUIRES_DATA_MODEL`, exaustiva: categoria nova não compila sem resposta |
| IB-09 | MEDIUM | Dois `catch {}` no gerador de e-mail tratavam QUALQUER falha como lista vazia e a linha seguinte sobrescrevia o arquivo — histórico de envios apagado em silêncio, **dentro de todo aplicativo gerado com formulário** | `readCapture` distingue ausente de corrompido; 3 testes, 1 falsificação |
