// Shared between the i18n gate and the baseline generator, so the two can never
// disagree about which revisions and which text count as legacy.
export const legacyRevision = 'ab0fe506928dacd736262a024d202f3e96e2689d'

/** Tips that existed before the gate began scanning plugin sources (M5), plus whatever the integrator lists. */
export function pluginBaselineRevisions() {
  return ['c0aeb53', ...(process.env.DZ23_I18N_PLUGIN_BASELINES ?? '').split(',').map(value => value.trim()).filter(Boolean)]
}

export function portugueseText(value) {
  return /[áéíóúàâêôãõç]/iu.test(value) || /\b(projeto|plano|criação|verificação|pergunta|serviços|diretório|arquivo|modelo|confirmação|solicitação|produza|caminhos|gere)\b/iu.test(value)
}
