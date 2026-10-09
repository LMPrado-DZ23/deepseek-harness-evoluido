import help from '../i18n/help.pt-BR.json'
import { STUDIO_HOME_PATH } from '../navigation'

/** O endereço da ajuda. */
export const HELP_PATH = help.path

/** Se este endereço é o da ajuda. */
export function isHelpPath(pathname: string): boolean {
  return pathname === HELP_PATH || pathname === `${HELP_PATH}/`
}

/**
 * A tela de ajuda.
 *
 * O produto é para quem não programa e usava vocabulário próprio o tempo todo
 * — protótipo, prévia local, ponto seguro, ambiente isolado, perfil de
 * privacidade — sem um único lugar onde descobrir o que essas palavras querem
 * dizer. O ícone de ajuda existia, e estava desligado.
 *
 * O conteúdo vem do catálogo, como todo texto: a ajuda que explica o produto
 * não pode ser a única parte dele que não se traduz.
 */
export function HelpScreen() {
  return <main className="help">
    <div className="heading"><div><h1>{help.title}</h1><p>{help.subtitle}</p></div></div>
    <section className="task-card">
      <h2>{help.stepsTitle}</h2>
      <ol>{help.steps.map(step => <li key={step}>{step}</li>)}</ol>
    </section>
    <section className="task-card">
      <h2>{help.glossaryTitle}</h2>
      <dl>{help.glossary.map(entry => <div key={entry.term}><dt>{entry.term}</dt><dd>{entry.meaning}</dd></div>)}</dl>
    </section>
    <section className="task-card">
      <h2>{help.privacyTitle}</h2>
      <ul>{help.privacy.map(line => <li key={line}>{line}</li>)}</ul>
    </section>
    <section className="task-card">
      <h2>{help.moreTitle}</h2>
      <p>{help.more}</p>
    </section>
    <a className="nav" href={STUDIO_HOME_PATH}>{help.backHome}</a>
  </main>
}
