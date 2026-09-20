# Blockers internos

Um blocker interno é um defeito ou lacuna que **depende só de nós**. Se depende
de credencial, hardware ou autorização de terceiro, ele é externo e mora em
`EXTERNAL_BLOCKERS.md` — e classificar um interno como externo para não
trabalhar nele é a forma mais comum de esconder trabalho.

Meta: `CRITICAL = 0` e `HIGH = 0`.

Estado histórico em 17/09/2026: **CRITICAL = 0, HIGH = 0.** Não é certificação
da árvore atual. A auditoria de 20/09 encontrou novos achados abaixo.

## Achados da auditoria de 20/09/2026

| ID | severidade | causa e evidência | estado |
| --- | --- | --- | --- |
| AUDIT-OCI-01 | HIGH | CLI de download calculava, mas não comparava, o digest de camadas e configuração. Reprodução anunciou sucesso com conteúdo adulterado | CORREÇÃO CANDIDATA — ver audit/FRIGG-AUDIT-20260920.md |
| AUDIT-FILES-01 | HIGH | 20 uploads concorrentes deixaram dois arquivos; um link em enviados redirecionou gravação para fora; download reabria caminho após validá-lo | CORREÇÃO CANDIDATA — testes reais de filesystem; paridade nativa fora de Linux/WSL pendente |
| AUDIT-PLAN-01 | HIGH | Resposta tardia do modelo sobrescrevia edicao/aprovacao; nova proposta podia ficar abaixo da revisao antiga | CORREÇÃO CANDIDATA — sete regressoes, cinco mutacoes; serializacao por instancia, CAS distribuido pendente |
| AUDIT-REPLAY-01 | HIGH | Reenvios nao tinham recibo; falha na rede descartava o rascunho; falha de leitura ficava invisivel | CORREÇÃO CANDIDATA — recibos, revisoes preservadas, auditoria recuperavel e regressao no navegador |
| ABRIR-03 | HIGH | Cadastro escondia projetos e arquivos pessoais | CORREÇÃO CANDIDATA — identidade preservada e JSON reaberto; continuidade de conversas pessoais permanece aberta |

A aprovação completa depende das quatro suítes e das limitações nomeadas no
relatório. Não reduzir os achados a zero apenas por existirem alterações.

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
| IB-11 | MEDIUM | `plugins/identity` (modo `loopback-http`) | **A defesa do nome forte depende da versão do navegador, e o comentário afirmava que não.** Medido no mesmo servidor e no mesmo endereço `studio.dz23.localhost` sem TLS: Chromium 133.0.6943.16 aceita `Secure` sobre http e **RECUSA** o prefixo `__Host-`; Chromium 141.0.7390.37 aceita os dois. Onde o prefixo é recusado, o aplicativo GERADO na prévia irmã volta a poder plantar `dz23_studio_session=…; Domain=dz23.localhost; Path=/api`, e `shadowCookieDeletions` não alcança esse caminho — a tranca da dona do Studio reabre. Não é roubo de conta: o servidor continua recusando a ambiguidade | FECHADO 18/09 — sem topologia, que ficou BLOQUEADA em certificado: a remoção passou a alcançar TODO caminho plantável que atinge alguma rota da identidade (`/`, `/api`, `/api/studio`, `/api/studio/identity` e cada fronteira de barra de cada rota), DERIVADO dos contratos de rota. A lista escrita à mão não tinha peso nenhum (a sabotagem que a encolhia sobrevivia) e ainda estava errada. A defesa principal continua sendo o nome `__Host-` |
| IB-05 | MEDIUM | `hasApprovedAncestor` decidia autorização só por linhagem de sessões, **sem** conferir o diretório de trabalho, e ficava exportada ao lado de `approvedGrantFor`, que confere. Ninguém chamava a insegura — o risco era o próximo leitor escolher pelo nome mais curto | removida; `approvedGrantFor` já era a única usada |
| IB-06 | LOW | `startDelegation`: porta de entrada pública para iniciar delegação, sem chamador e sem teste | removida |
| IB-07 | MEDIUM | O botão "Voltar para este ponto" aparecia para toda tentativa verde, inclusive **durante a criação**, e a recusa do servidor só chegava depois de confirmar | `UNDO_AVAILABLE_BY_STATE`, tabela exaustiva espelhando o servidor; 6 testes, 2 falsificações |
| IB-08 | MEDIUM | Duas listas negadas de categoria que precisavam concordar entre si; categoria nova caía num `return` silencioso e gerava aplicativo com formulário e sem banco | `CATEGORY_REQUIRES_DATA_MODEL`, exaustiva: categoria nova não compila sem resposta |
| IB-09 | MEDIUM | Dois `catch {}` no gerador de e-mail tratavam QUALQUER falha como lista vazia e a linha seguinte sobrescrevia o arquivo — histórico de envios apagado em silêncio, **dentro de todo aplicativo gerado com formulário** | `readCapture` distingue ausente de corrompido; 3 testes, 1 falsificação |
| IB-10 | **HIGH** (era MEDIUM) | `plugins/builder-supervisor` | Começou como teste intermitente e terminou como defeito de segurança do produto: `(dev, ino)` não é identidade, é endereço, e o ext4 recicla inode. O supervisor apagava socket **de outro processo**. Medido: 150/150 fechamentos reciclaram o inode | **FECHADO** — `birthtimeNs` entrou no par de identidade nos quatro pontos que decidiam, inclusive no `owner.json`, onde a janela é de minutos e reinícios |
