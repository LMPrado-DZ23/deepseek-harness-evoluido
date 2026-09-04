import { ArrowLeft, Download, Mail, Plug, ScrollText } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import t from '../i18n/hub.pt-BR.json'
import { createHubApi, HubApiError, type ExportRecord, type HubApi, type HubEvent, type Integration, type ProjectSummary, type SmtpState } from './hubApi'
import { actionLabel, enableExplanation, exportable, fill, formatBytes, formatDate, kindLabel, outcomeLabel, tierLabel, verificationLabel } from './presentation'
import './hub.css'

type Notice = { kind: 'ok' | 'error' | 'info'; text: string } | null

/**
 * Integration Hub panel (M5). A separate screen at `/studio/hub` so the main
 * application stays untouched. Every server refusal is shown in words; the
 * panel never claims a state the server did not report.
 */
export function HubPanel({ api = createHubApi(), homeHref = '/studio/' }: { api?: HubApi; homeHref?: string }) {
  const [smtp, setSmtp] = useState<SmtpState | null>(null)
  const [integrations, setIntegrations] = useState<Integration[] | null>(null)
  const [channel, setChannel] = useState<'stable' | 'dev'>('stable')
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [events, setEvents] = useState<HubEvent[] | null>(null)
  const [notice, setNotice] = useState<Notice>(null)

  const report = useCallback((error: unknown) => {
    if (error instanceof HubApiError && error.offline) return setNotice({ kind: 'error', text: t.offline })
    setNotice({ kind: 'error', text: error instanceof Error && error.message !== '' ? error.message : t.errors.generic })
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [smtpState, list, projectList, log] = await Promise.all([api.smtp(), api.integrations(), api.projects(), api.events()])
      setSmtp(smtpState); setIntegrations(list.integrations); setChannel(list.channel); setProjects(projectList); setEvents(log)
    } catch (error) { report(error) }
  }, [api, report])

  useEffect(() => { void refresh() }, [refresh])

  return <div className="hub-page">
    <header className="hub-header">
      <a className="hub-back" href={homeHref}><ArrowLeft aria-hidden="true" /><span>{t.back}</span></a>
      <div><h1>{t.title}</h1><p>{t.subtitle}</p></div>
    </header>
    {notice === null ? null : <p className={`hub-notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</p>}
    <main className="hub-grid">
      <SmtpSection api={api} state={smtp} onChange={async () => { setSmtp(await api.smtp()); setEvents(await api.events()) }} notify={setNotice} report={report} />
      <IntegrationsSection api={api} integrations={integrations} channel={channel} onChange={async () => { const list = await api.integrations(); setIntegrations(list.integrations); setChannel(list.channel); setEvents(await api.events()) }} notify={setNotice} report={report} />
      <ExportsSection api={api} projects={projects} onChange={async () => { setEvents(await api.events()) }} notify={setNotice} report={report} />
      <EventsSection events={events} />
    </main>
  </div>
}

type SectionProps = { api: HubApi; notify(notice: Notice): void; report(error: unknown): void; onChange(): Promise<void> }

function SmtpSection({ api, state, onChange, notify, report }: SectionProps & { state: SmtpState | null }) {
  const [secretRef, setSecretRef] = useState('')
  const [recipient, setRecipient] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (task: () => Promise<void>) => { setBusy(true); notify(null); try { await task(); await onChange() } catch (error) { report(error) } finally { setBusy(false) } }
  return <section className="hub-card" aria-labelledby="hub-smtp-title">
    <div className="hub-card-heading"><Mail aria-hidden="true" /><h2 id="hub-smtp-title">{t.smtp.title}</h2></div>
    <p className="hub-help">{t.smtp.help}</p>
    <p className="hub-state" data-testid="smtp-state"><strong>{t.smtp.status}:</strong> {state === null ? t.loading : state.configured && state.secret_ref !== null ? fill(t.smtp.configured, { ref: state.secret_ref }) : t.smtp.notConfigured}</p>
    {state === null ? null : <p className="hub-state"><strong>{t.smtp.tier}:</strong> {tierLabel(state.tier)}</p>}
    <form onSubmit={event => { event.preventDefault(); void run(async () => { await api.configureSmtp(secretRef.trim()); notify({ kind: 'ok', text: t.smtp.saved }) }) }}>
      <label htmlFor="hub-smtp-ref">{t.smtp.refLabel}</label>
      <input id="hub-smtp-ref" value={secretRef} onChange={event => setSecretRef(event.target.value)} placeholder={t.smtp.refPlaceholder} autoComplete="off" spellCheck={false} />
      <button type="submit" className="primary" disabled={busy || secretRef.trim() === ''}>{t.smtp.save}</button>
    </form>
    <form onSubmit={event => { event.preventDefault(); void run(async () => { const result = await api.testSmtp(recipient.trim()); notify({ kind: result.result === 'SENT' ? 'ok' : 'info', text: `${result.result === 'SENT' ? t.smtp.testSent : t.smtp.testNotExecuted}: ${result.message}` }) }) }}>
      <label htmlFor="hub-smtp-to">{t.smtp.testLabel}</label>
      <input id="hub-smtp-to" type="email" value={recipient} onChange={event => setRecipient(event.target.value)} placeholder={t.smtp.testPlaceholder} />
      <button type="submit" className="secondary" disabled={busy || state?.configured !== true || recipient.trim() === ''}>{t.smtp.test}</button>
    </form>
  </section>
}

function IntegrationsSection({ api, integrations, channel, onChange, notify, report }: SectionProps & { integrations: Integration[] | null; channel: 'stable' | 'dev' }) {
  const [manifestText, setManifestText] = useState('')
  const [reasons, setReasons] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const visible = useMemo(() => (integrations ?? []).filter(value => value.kind !== 'smtp'), [integrations])
  const run = async (task: () => Promise<void>) => { setBusy(true); notify(null); try { await task(); await onChange() } catch (error) { report(error) } finally { setBusy(false) } }
  return <section className="hub-card" aria-labelledby="hub-integrations-title">
    <div className="hub-card-heading"><Plug aria-hidden="true" /><h2 id="hub-integrations-title">{t.integrations.title}</h2></div>
    <p className="hub-help">{t.integrations.help}</p>
    {channel === 'dev' ? <p className="hub-state hub-channel" data-testid="hub-channel">{t.integrations.devChannel}</p> : null}
    {integrations === null ? <p>{t.loading}</p> : visible.length === 0 ? <p className="hub-empty">{t.integrations.empty}</p> : <ul className="hub-list" data-testid="integration-list">
      {visible.map(item => <li key={item.integration_id} data-testid="integration-item">
        <div><strong>{item.name}</strong><span className="hub-meta">{kindLabel(item.kind)}</span></div>
        <div className="hub-tags"><span className={`hub-tag ${item.verification}`}>{verificationLabel(item.verification)}</span><span className="hub-tag">{tierLabel(item.effective_tier)}</span><span className={`hub-tag ${item.enabled ? 'on' : 'off'}`}>{item.enabled ? t.integrations.enabled : t.integrations.disabled}</span></div>
        {item.enabled
          ? <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => api.setEnabled(item.integration_id, false).then(() => undefined))}>{t.integrations.disable}</button>
          : <>
            {enableExplanation(item) === null ? null : <p className="hub-why" id={`why-${item.integration_id}`}>{enableExplanation(item)}</p>}
            <button type="button" className="primary" disabled={busy || !item.can_enable} aria-describedby={enableExplanation(item) === null ? undefined : `why-${item.integration_id}`} onClick={() => void run(() => api.setEnabled(item.integration_id, true).then(() => undefined))}>{t.integrations.enable}</button>
          </>}
      </li>)}
    </ul>}
    <details className="hub-advanced">
      <summary>{t.integrations.registerTitle}</summary>
      <p className="hub-help">{t.integrations.registerHelp}</p>
      <form onSubmit={event => {
        event.preventDefault()
        let manifest: unknown
        try { manifest = JSON.parse(manifestText) } catch { notify({ kind: 'error', text: t.errors.manifestJson }); return }
        void run(async () => { const result = await api.register(manifest); setReasons(result.reasons); notify({ kind: 'ok', text: t.integrations.registered }) })
      }}>
        <label htmlFor="hub-manifest">{t.integrations.manifestLabel}</label>
        <textarea id="hub-manifest" value={manifestText} onChange={event => setManifestText(event.target.value)} rows={8} spellCheck={false} />
        <button type="submit" className="secondary" disabled={busy || manifestText.trim() === ''}>{t.integrations.register}</button>
      </form>
      {reasons.length === 0 ? null : <><h3>{t.integrations.reasons}</h3><ul className="hub-reasons">{reasons.map(reason => <li key={reason}>{reason}</li>)}</ul></>}
    </details>
  </section>
}

function ExportsSection({ api, projects, onChange, notify, report }: SectionProps & { projects: ProjectSummary[] | null }) {
  const [projectId, setProjectId] = useState('')
  const [exports, setExports] = useState<ExportRecord[] | null>(null)
  const [busy, setBusy] = useState(false)
  const projectIdRef = useRef(projectId)
  projectIdRef.current = projectId
  const selected = useMemo(() => projects?.find(value => value.project_id === projectId), [projects, projectId])
  useEffect(() => { if (projectId === '' && projects !== null && projects.length > 0) setProjectId(projects.find(exportable)?.project_id ?? projects[0]!.project_id) }, [projects, projectId])
  useEffect(() => {
    if (projectId === '') return
    let cancelled = false
    api.exports(projectId).then(list => { if (!cancelled) setExports(list) }).catch(report)
    return () => { cancelled = true }
  }, [api, projectId, report])
  const create = async () => {
    const target = projectId
    setBusy(true); notify(null)
    try {
      await api.createExport(target)
      const list = await api.exports(target)
      // The person may have switched projects while the package was being built: never show one project's list under another.
      setExports(current => (projectIdRef.current === target ? list : current))
      notify({ kind: 'ok', text: t.exports.created }); await onChange()
    } catch (error) { report(error) } finally { setBusy(false) }
  }
  return <section className="hub-card" aria-labelledby="hub-exports-title">
    <div className="hub-card-heading"><Download aria-hidden="true" /><h2 id="hub-exports-title">{t.exports.title}</h2></div>
    <p className="hub-help">{t.exports.help}</p>
    {projects === null ? <p>{t.loading}</p> : projects.length === 0 ? <p className="hub-empty">{t.exports.noProjects}</p> : <>
      <label htmlFor="hub-project">{t.exports.projectLabel}</label>
      <select id="hub-project" value={projectId} onChange={event => setProjectId(event.target.value)}>
        {projects.map(project => <option key={project.project_id} value={project.project_id}>{project.name}</option>)}
      </select>
      {selected !== undefined && !exportable(selected) ? <p className="hub-state">{t.exports.stateNote}</p> : null}
      <button type="button" className="primary" disabled={busy || selected === undefined || !exportable(selected)} onClick={() => void create()}>{t.exports.create}</button>
      {exports === null ? null : exports.length === 0 ? <p className="hub-empty">{t.exports.empty}</p> : <ul className="hub-list" data-testid="export-list">
        {[...exports].sort((left, right) => right.created_at.localeCompare(left.created_at)).map(record => <li key={record.export_id} data-testid="export-item">
          <a className="hub-download" href={api.downloadHref(record.project_id, record.export_id)} download={record.file_name}><Download aria-hidden="true" />{fill(t.exports.download, { file: record.file_name })}</a>
          <dl className="hub-facts">
            <dt>{t.exports.digest}</dt><dd><code>{record.sha256}</code></dd>
            <dt>{t.exports.size}</dt><dd>{formatBytes(record.size_bytes)}</dd>
            <dt>{t.exports.entries}</dt><dd>{record.entries}</dd>
            <dt>{t.exports.createdAt}</dt><dd>{formatDate(record.created_at)}</dd>
          </dl>
        </li>)}
      </ul>}
    </>}
  </section>
}

function EventsSection({ events }: { events: HubEvent[] | null }) {
  return <section className="hub-card hub-events" aria-labelledby="hub-events-title">
    <div className="hub-card-heading"><ScrollText aria-hidden="true" /><h2 id="hub-events-title">{t.events.title}</h2></div>
    <p className="hub-help">{t.events.help}</p>
    {events === null ? <p>{t.loading}</p> : events.length === 0 ? <p className="hub-empty">{t.events.empty}</p> : <ol className="hub-timeline" data-testid="event-list">
      {[...events].sort((left, right) => right.created_at.localeCompare(left.created_at)).slice(0, 50).map(event => <li key={event.event_id}>
        <span className={`hub-tag ${event.outcome}`}>{outcomeLabel(event.outcome)}</span>
        <strong>{actionLabel(event.action)}</strong>
        <time dateTime={event.created_at}>{formatDate(event.created_at)}</time>
      </li>)}
    </ol>}
  </section>
}
