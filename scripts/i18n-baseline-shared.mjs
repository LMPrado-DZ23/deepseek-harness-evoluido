// Shared between the i18n gate and the baseline generator, so the two can never
// disagree about which revisions and which text count as legacy.
export const legacyRevision = 'ab0fe506928dacd736262a024d202f3e96e2689d'

/** Tips that existed before the gate began scanning plugin sources (M5), plus whatever the integrator lists. */
export function pluginBaselineRevisions() {
  return ['c0aeb53', ...(process.env.DZ23_I18N_PLUGIN_BASELINES ?? '').split(',').map(value => value.trim()).filter(Boolean)]
}

/**
 * Se um literal é texto em português.
 *
 * A primeira versão olhava só para acentos e para uma lista fechada de palavras
 * acentuadas — e isso tinha um buraco que não era teórico: bastava ESCREVER SEM
 * ACENTO para o portão aprovar a frase. `plugins/route-health/src/service.ts`
 * fazia exatamente isso, com um comentário admitindo o motivo. O verde do
 * portão media o que o detector conseguia enxergar, não o que existia.
 *
 * Por isso a detecção também olha para palavras funcionais do português SEM
 * acento. Elas vêm em dois grupos porque o custo do erro é diferente nos dois
 * lados: `strongWords` são palavras que praticamente não ocorrem em inglês nem
 * em identificador de código, e uma só já denuncia a frase; `weakWords` são
 * palavras curtas que colidem com inglês, domínio (`example.com`) e caminho, e
 * por isso só contam quando DUAS delas distintas aparecem no mesmo literal —
 * uma frase inteira em português sempre traz várias, um `'example.com'` traz uma.
 */
const strongWords = /\b(nao|voce|entao|tambem|porque|enquanto|nenhum|nenhuma|nenhuns|nenhumas|espaco|criacao|verificacao|confirmacao|solicitacao|diretorio|servicos|acao|acoes|sessao|conexao|informacao|informacoes|disponivel|indisponivel|ultimo|ultima|proximo|proxima|usuario|senha|precisa|tentar|tente|escolha|escolher|aguarde|falhou|salvar|excluir|enviar|apenas|ainda|agora|sempre|nunca)\b/iu

const weakWords = /\b(de|da|do|das|dos|para|que|uma|um|com|sem|esta|este|essa|esse|isso|pela|pelo|pelos|pelas|quando|foi|ser|seu|sua|mais|muito|todo|toda|todos|todas|aqui|nesta|neste|deste|desta|numa|num|como|onde|antes|depois|dentro|fora|em|ao|aos|nas|nos|nada|entre|sobre|cada|outra|outro|se|ou|ele|ela|eles|elas|nem|mas|ate|apos|sao|tem|foram|era|pode|podem|deve|devem|ja|so)\b/giu

export function portugueseText(value) {
  if (/[\u00e1\u00e9\u00ed\u00f3\u00fa\u00e0\u00e2\u00ea\u00f4\u00e3\u00f5\u00e7]/iu.test(value)) return true
  if (/\b(projeto|plano|cria\u00e7\u00e3o|verifica\u00e7\u00e3o|pergunta|servi\u00e7os|diret\u00f3rio|arquivo|modelo|confirma\u00e7\u00e3o|solicita\u00e7\u00e3o|produza|caminhos|gere)\b/iu.test(value)) return true
  if (strongWords.test(value)) return true
  const distinct = new Set([...(value.match(weakWords) ?? [])].map(word => word.toLowerCase()))
  return distinct.size >= 2
}
