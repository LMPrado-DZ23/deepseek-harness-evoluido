import { buildStepLabel, buildStepRows, buildStepStateLabel, type RunStepRecord } from './buildSteps'
import t from './i18n/pt-BR.json'

/**
 * A linha do tempo da construção, enquanto ela acontece.
 *
 * O Prado descreveu o que faltava assim: "a ideia desse projeto é ver a
 * construção em tempo real". Até aqui a tela dizia uma frase por ETAPA —
 * `build` ou `test` — e o construtor roda quatro passos dentro dessas duas.
 * Durante os minutos mais longos do produto a pessoa via um texto imóvel: nada
 * na tela separava "instalando as dependências" de "compilando" de "travado".
 *
 * O `aria-live="polite"` fica na lista inteira, e não em cada linha: um leitor
 * de tela anunciando quatro mudanças separadas viraria tagarelice justamente no
 * momento em que a pessoa está tensa esperando.
 */
export function BuildSteps({ steps, finished }: { readonly steps: readonly RunStepRecord[] | undefined; readonly finished: boolean }) {
  const rows = buildStepRows(steps, finished)
  return <section className="build-steps">
    {/* `h2`, e nao `h3`. A tela da criacao tem um `h1` no topo, e pular de 1
        para 3 quebra a ordem dos titulos - quem navega por titulos com leitor
        de tela perde o degrau. Foi o axe que apanhou, e so apanhou porque este
        pedaco da tela ganhou varredura propria: a varredura do fluxo principal
        nao passa por aqui, porque a linha do tempo so existe com uma execucao
        congelada no meio. */}
    <h2>{t.creation.steps.title}</h2>
    <ol aria-live="polite">
      {rows.map(row => <li key={row.step} className={`build-step build-step-${row.state}`}>
        {/* O ponto é decorativo: quem usa leitor de tela recebe a MESMA
            informação em palavras logo ao lado. Cor sozinha nunca carrega o
            estado — no escuro, e para quem não distingue verde de vermelho,
            ela desaparece. */}
        <span className="build-step-dot" aria-hidden="true" />
        <span className="build-step-label">{buildStepLabel(row.step)}</span>
        <span className="build-step-state">{buildStepStateLabel(row.state)}</span>
        {row.seconds === null ? null : <span className="build-step-time">{t.creation.steps.elapsed.replace('{s}', String(row.seconds))}</span>}
      </li>)}
    </ol>
  </section>
}
