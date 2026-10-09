import { describe, it } from 'vitest'
import { suggestCategory } from '../../apps/studio-web/src/categorySuggestion'
import signals from '../../apps/studio-web/src/i18n/categorySignals.pt-BR.json'

function norm(t: string) { return ` ${t.normalize('NFD').replace(/[̀-ͯ]/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim()} ` }
function score(t: string) {
  const x = norm(t); let best = 0
  for (const list of Object.values(signals as Record<string, [string, number][]>)) {
    let s = 0; for (const [sig, w] of list) if (x.includes(sig)) s += w
    if (s > best) best = s
  }
  return best
}
const TEXTOS = [
  'salao de beleza, cliente escolhe dia e hora com a manicure',
  'quero q as pessoa marque hora comigo pelo celular',
  'sistema pra barbearia',
  'controle de ordens de servico da oficina, mexer nos dados',
  'saber quanto entrou e quanto saiu por semana',
  'quero um sistema para minha clinica',
  'um app pra minha loja',
  'axo q preciso d um lugar pra guarda os nome dos meu cliente',
  'AJENDA PRA MINHA CLINICA',
  'quero organizar minhas coisa do trabalho',
  'me ajuda a fazer um negocio pra vender bolo',
  'preciso controlar quem me deve',
  'app de delivery',
  'sistema de ponto dos funcionarios',
  'loja virtual com carrinho e pagamento',
  'rede social pra minha igreja',
  'quero um chat com meus clientes',
  'controle financeiro do meu mei',
  'quero registrar as horas que trabalhei em cada obra',
  'um lugar pra minha banda divulgar os shows',
]
describe('queda', () => { it('mede', async () => {
  const linhas = TEXTOS.map(t => `${score(t) === 0 ? 'QUEDA-CEGA' : `pontuou ${score(t)} `}\t${suggestCategory(t).padEnd(16)}\t${t}`)
  const cegas = TEXTOS.filter(t => score(t) === 0).length
  ;(await import('node:fs')).writeFileSync('/home/claude/integ/audit/verificacao/queda.txt', `${cegas}/${TEXTOS.length} caem no padrao sem NENHUM sinal\n${linhas.join('\n')}`)
}) })
