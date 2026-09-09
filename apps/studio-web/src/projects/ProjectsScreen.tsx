import { useEffect, useState } from 'react'
import { api } from '../api'
import { STUDIO_HOME_PATH } from '../navigation'
import { projectAddress } from '../App'
import type { ProjectUiState } from '../presentation'
import { projectCount, projectStateLabel, readableDate } from './presentation'
import t from '../i18n/pt-BR.json'

/** O endereço da lista de projetos. */
export const PROJECTS_PATH = '/studio/projetos'

/** Se este endereço é o da lista de projetos. */
export function isProjectsPath(pathname: string): boolean {
  return pathname === PROJECTS_PATH || pathname === `${PROJECTS_PATH}/`
}

export interface ProjectRow {
  readonly project_id: string
  readonly name: string
  readonly state: ProjectUiState
  readonly category: string
  readonly updated_at: string
}

/**
 * A lista dos projetos da pessoa.
 *
 * Este item da navegação existia desde o começo marcado "em breve", e a rota do
 * servidor (`GET /projects`) já respondia havia meses: o que faltava era só a
 * tela. Enquanto ela não existia, quem fechava o navegador no meio de uma
 * criação não tinha caminho de volta pela interface — o projeto continuava lá,
 * inalcançável.
 *
 * Cada linha leva ao projeto pelo endereço (`?projeto=`), que é o mesmo
 * mecanismo que a tela inicial já usa para sobreviver a uma recarga.
 */
export function ProjectsScreen() {
  const [rows, setRows] = useState<readonly ProjectRow[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setFailed(false)
    void api<{ projects: readonly ProjectRow[] }>('/projects')
      .then(body => { if (!cancelled) setRows(body.projects) })
      .catch(() => { if (!cancelled) { setRows(null); setFailed(true) } })
    return () => { cancelled = true }
  }, [attempt])

  const count = rows?.length ?? 0
  return <main className="projects">
    <div className="heading"><div><h1>{t.projects.title}</h1><p>{t.projects.subtitle}</p></div></div>

    {failed ? <section className="task-card">
      <p role="alert">{t.projects.failed}</p>
      <button type="button" className="primary" onClick={() => setAttempt(value => value + 1)}>{t.projects.retry}</button>
    </section> : null}

    {!failed && rows === null ? <p role="status">{t.projects.loading}</p> : null}

    {rows !== null && rows.length === 0 ? <section className="task-card">
      <p>{t.projects.empty}</p>
      <a className="primary project-cta" href={STUDIO_HOME_PATH}>{t.projects.emptyAction}</a>
    </section> : null}

    {rows !== null && rows.length > 0 ? <section className="task-card">
      {/* A contagem vem antes da lista porque quem tem trinta projetos precisa
          saber disso antes de rolar, e quem tem um não precisa contar. */}
      <p className="project-count">{projectCount(count)}</p>
      <ul className="project-list">
        {rows.map(row => <li key={row.project_id}>
          <div className="project-line">
            <strong>{row.name}</strong>
            <span className="project-state">{projectStateLabel(row.state)}</span>
          </div>
          <div className="project-meta">
            <span>{t.projects.columnUpdated}: {readableDate(row.updated_at)}</span>
          </div>
          {/* Um link, e não um botão: abrir um projeto é navegar, e quem usa
              teclado ou leitor de tela espera que dê para abrir em outra aba. */}
          <a className="secondary project-open" href={projectAddress(new URL(STUDIO_HOME_PATH, window.location.origin).toString(), row.project_id)}
            aria-label={t.projects.openLabel.replace('{name}', row.name)}>{t.projects.open}</a>
        </li>)}
      </ul>
    </section> : null}
  </main>
}
