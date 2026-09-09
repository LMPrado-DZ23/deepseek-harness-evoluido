import { ArrowLeft, Download, Mail, Plug, ScrollText, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import t from '../i18n/hub.pt-BR.json'
import { createHubApi, HubApiError, type ExportRecord, type HubApi, type HubEvent, type Integration, type IntegrationCatalog, type IntegrationTestResult, type ProjectSummary, type RemovedIntegration, type SmtpState } from './hubApi'
import { CATALOG_PAGE_SIZE, actionLabel, approvalNote, approvalPrompt, catalogCount, catalogEmptyMessage, confirmStep, costLabel, enableExplanation, exportable, fill, formatBytes, formatDate, healthCounts, healthLabel, kindLabel, outcomeLabel, tierLabel, verificationLabel, type ConfirmStepModel, type KindFilter, type StatusFilter } from './presentation'
import { WebMcpPanel, useWebMcpSetting } from '../webmcp/WebMcpPanel'
import { browserModelContext, registerStudioTools } from '../webmcp/tools'
import { studioPort } from '../webmcp/studioPort'
import './hub.css'

type Notice = { kind: 'ok' | 'error' | 'info'; text: string } | null

/**
 * One action waiting for the person's confirmation. The panel never sends an
 * approval the person did not click: the tier comes from the server, and the
 * text says, in plain words, what agreeing to it means. Nothing at all is sent
 * while the box is on screen — the decision is asked for INSIDE `confirm()`, so
 * cancelling leaves no ticket and no audit event behind on the server.
 */
type Pending = ConfirmStepModel | null
const defaultHubApi = createHubApi()

function ConfirmStep({ pending, busy, onCancel, onConfirm }: { pending: Pending; busy: boolean; onCancel(): void; onConfirm(): void }) {
  if (pending === null) return null
  return <div className="hub-confirm" role="group" aria-label={t.confirm.title} data-testid="hub-confirm">
    <p><strong>{t.confirm.title}</strong></p>
    <p>{pending.what}</p>
    <p>{approvalPrompt(pending.tier)}</p>
    <button type="button" className="primary" disabled={busy} onClick={onConfirm}>{t.confirm.confirm}</button>
    <button type="button" className="secondary" disabled={busy} onClick={onCancel}>{t.confirm.cancel}</button>
  </div>
}

/**
 * Integration Hub panel (M5). A separate screen at `/studio/hub` so the main
 * application stays untouched. Every server refusal is shown in words; the
 * panel never claims a state the server did not report.
 */
/**
 * O controle do WebMCP dentro do Hub.
 *
 * A porta que as ferramentas usam é a MESMA `api` do produto: nenhuma
 * ferramenta ganha caminho próprio, e por isso a seção monta a porta a partir
 * das chamadas que a tela já faz.
 */
function WebMcpSection() {
  const storage = typeof window === 'undefined' ? undefined : window.localStorage
  const [enabled, setEnabled] = useWebMcpSetting(storage)
  const context = typeof document === 'undefined' ? undefined : browserModelContext(document as unknown as { modelContext?: unknown })
  useEffect(() => {
    if (!enabled || context === undefined) return undefined
    const controller = new AbortController()
    void registerStudioTools(context, studioPort, controller.signal)
    // Desligar ABORTA, e é isto que tira as ferramentas do catálogo do agente:
    // esconder o botão deixaria as ferramentas registradas.
    return () => { controller.abort() }
  }, [enabled, context])
  return <WebMcpPanel available={context !== undefined} enabled={enabled} setEnabled={setEnabled} port={studioPort} />
}

export function HubPanel({ api = defaultHubApi, homeHref = '/studio/' }: { api?: HubApi; homeHref?: string }) {
  const [smtp, setSmtp] = useState<SmtpState | null>(null)
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [events, setEvents] = useState<HubEvent[] | null>(null)
  const [notice, setNotice] = useState<Notice>(null)

  const report = useCallback((error: unknown) => {
    if (error instanceof HubApiError && error.offline) return setNotice({ kind: 'error', text: t.offline })
    setNotice({ kind: 'error', text: error instanceof Error && error.message !== '' ? error.message : t.errors.generic })
  }, [])

  const refresh = useCallback(async () => {
    try {
      // O catálogo NÃO é lido aqui: ele tem busca, filtro e página próprios, e
      // recarregá-lo junto com o resto apagaria o que a pessoa acabou de pedir.
      const [smtpState, projectList, log] = await Promise.all([api.smtp(), api.projects(), api.events()])
      setSmtp(smtpState); setProjects(projectList); setEvents(log)
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
      <IntegrationsSection api={api} onChange={async () => { setEvents(await api.events()) }} notify={setNotice} report={report} />
      <ExportsSection api={api} projects={projects} onChange={async () => { setEvents(await api.events()) }} notify={setNotice} report={report} />
      {/* O WebMCP mora AQUI, e não numa tela de ajustes: o Hub é a tela do "o
          que pode agir em nome deste espaço de trabalho", e o assistente do
          navegador é exatamente mais um desses. */}
      <WebMcpSection />
      <EventsSection events={events} />
    </main>
  </div>
}

type SectionProps = { api: HubApi; notify(notice: Notice): void; report(error: unknown): void; onChange(): Promise<void> }

function SmtpSection({ api, state, onChange, notify, report }: SectionProps & { state: SmtpState | null }) {
  const [secretRef, setSecretRef] = useState('')
  const [recipient, setRecipient] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<Pending>(null)
  const run = async (task: () => Promise<void>) => { setBusy(true); notify(null); try { await task(); await onChange() } catch (error) { report(error) } finally { setBusy(false) } }
  const ask = (input: Omit<Parameters<typeof confirmStep>[0], 'requestApproval'>) => {
    // One confirmation at a time. The box is built from the level the server already published for
    // this row; the decision itself is only asked for if the person agrees.
    if (busy || pending !== null) return
    setPending(confirmStep({ ...input, requestApproval: api.requestApproval }))
  }
  const confirm = () => {
    const step = pending
    if (step === null) return
    setPending(null)
    void run(async () => {
      const outcome = await step.confirm()
      // The server now demands MORE than the box said (the record changed while the person read it):
      // nothing was done, and the same action is asked again at the level it really costs.
      if (outcome.kind === 'tier-changed') { setPending(outcome.step); notify({ kind: 'info', text: t.confirm.changed }) }
    })
  }
  return <section className="hub-card" aria-labelledby="hub-smtp-title">
    <div className="hub-card-heading"><Mail aria-hidden="true" /><h2 id="hub-smtp-title">{t.smtp.title}</h2></div>
    <p className="hub-help">{t.smtp.help}</p>
    <p className="hub-state" data-testid="smtp-state"><strong>{t.smtp.status}:</strong> {state === null ? t.loading : state.configured && state.secret_ref !== null ? fill(t.smtp.configured, { ref: state.secret_ref }) : t.smtp.notConfigured}</p>
    {state === null ? null : <p className="hub-state"><strong>{t.smtp.tier}:</strong> {tierLabel(state.tier)}</p>}
    <form onSubmit={event => {
      event.preventDefault()
      notify(null)
      const ref = secretRef.trim()
      // The SERVER decides the tier and issues the approval; the panel only shows what it said and,
      // if the person agrees, hands the id back. A confirmation the client invents is worth nothing.
      void ask({
        tier: state?.tier ?? 'T2', action: 'smtp.configured', subjectId: 'smtp', payload: ref, describe: () => t.confirm.smtpSave,
        run: async approval => { await api.configureSmtp(ref, approval); notify({ kind: 'ok', text: t.smtp.saved }) },
      })
    }}>
      <label htmlFor="hub-smtp-ref">{t.smtp.refLabel}</label>
      <input id="hub-smtp-ref" value={secretRef} onChange={event => setSecretRef(event.target.value)} placeholder={t.smtp.refPlaceholder} autoComplete="off" spellCheck={false} aria-describedby="hub-smtp-ref-help" />
      {/* Enviar e-mail é a função mais banal que um aplicativo vai querer, e
          configurá-la exigia saber o que é um segredo no cofre do servidor. A
          ajuda diz, na hora, que ali vai um NOME e a quem pedir esse nome. */}
      <p id="hub-smtp-ref-help" className="context-note">{t.smtp.refHelp}</p>
      <button type="submit" className="primary" disabled={busy || secretRef.trim() === ''}>{t.smtp.save}</button>
    </form>
    <form onSubmit={event => {
      event.preventDefault()
      notify(null)
      const to = recipient.trim()
      void ask({
        tier: state?.tier ?? 'T2', action: 'smtp.tested', subjectId: 'smtp', payload: to, describe: () => t.confirm.smtpTest,
        run: async approval => {
          const result = await api.testSmtp(to, approval)
          notify({ kind: result.result === 'SENT' ? 'ok' : 'info', text: `${result.result === 'SENT' ? t.smtp.testSent : t.smtp.testNotExecuted}: ${result.message}` })
        },
      })
    }}>
      <label htmlFor="hub-smtp-to">{t.smtp.testLabel}</label>
      <input id="hub-smtp-to" type="email" value={recipient} onChange={event => setRecipient(event.target.value)} placeholder={t.smtp.testPlaceholder} />
      <button type="submit" className="secondary" disabled={busy || state?.configured !== true || recipient.trim() === ''}>{t.smtp.test}</button>
    </form>
    <ConfirmStep pending={pending} busy={busy} onCancel={() => setPending(null)} onConfirm={confirm} />
  </section>
}

/**
 * O catálogo (X-01) e a saúde de cada integração (X-08).
 *
 * Quem busca, filtra, ordena e corta é o SERVIDOR: esta tela manda a pergunta e
 * recebe uma página. Receber tudo e filtrar aqui não seria paginação — seria
 * fingir que é, e o custo cresceria junto com o catálogo de quem tem muitas.
 */
function IntegrationsSection({ api, onChange, notify, report }: SectionProps) {
  const [manifestText, setManifestText] = useState('')
  const [reasons, setReasons] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<Pending>(null)
  // O que está NA CAIXA e o que já foi PERGUNTADO são coisas diferentes: a
  // busca só vai ao servidor quando a pessoa pede, e a lista abaixo continua
  // sendo o resultado da pergunta anterior até lá.
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState<{ search: string; kind: KindFilter; status: StatusFilter }>({ search: '', kind: 'all', status: 'all' })
  const [rows, setRows] = useState<Integration[] | null>(null)
  const [page, setPage] = useState<IntegrationCatalog | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  /** O que o último teste de conexão disse, por integração (X-04). Vazio = ninguém testou nesta visita. */
  const [tests, setTests] = useState<Readonly<Record<string, IntegrationTestResult | 'RUNNING'>>>({})

  const load = useCallback(async (next: { search: string; kind: KindFilter; status: StatusFilter }) => {
    const answer = await api.integrations({ ...next, limit: CATALOG_PAGE_SIZE })
    setRows(answer.integrations)
    setPage(answer)
  }, [api])

  useEffect(() => { load(query).catch(report) }, [load, query, report])

  const more = async () => {
    const cursor = page?.next_cursor
    if (cursor === undefined || cursor === null || loadingMore) return
    setLoadingMore(true)
    try {
      const answer = await api.integrations({ ...query, limit: CATALOG_PAGE_SIZE, cursor })
      // Acrescenta à lista que já está na tela: "carregar mais" continua de onde
      // parou, e não troca o que a pessoa estava lendo por outra página.
      setRows(current => [...(current ?? []), ...answer.integrations])
      setPage(answer)
    } catch (error) { report(error) } finally { setLoadingMore(false) }
  }

  const refreshCatalog = async () => { await load(query); await onChange() }
  const run = async (task: () => Promise<void>) => { setBusy(true); notify(null); try { await task(); await refreshCatalog() } catch (error) { report(error) } finally { setBusy(false) } }
  const ask = (input: Omit<Parameters<typeof confirmStep>[0], 'requestApproval'>) => {
    // One confirmation at a time. The box is built from the level the server already published for
    // this row; the decision itself is only asked for if the person agrees.
    if (busy || pending !== null) return
    setPending(confirmStep({ ...input, requestApproval: api.requestApproval }))
  }
  const enable = (item: Integration) => {
    const tier = item.requires_approval_tier
    // T0/T1 go straight through; T2/T3 ask the server for an approval first.
    if (tier === null || tier === undefined) return void run(() => api.setEnabled(item.integration_id, true).then(() => undefined))
    notify(null)
    void ask({
      tier, action: 'integration.enabled', subjectId: item.integration_id,
      describe: decided => fill(t.integrations.needsApproval, { tier: tierLabel(decided) }),
      run: approval => api.setEnabled(item.integration_id, true, approval).then(() => undefined),
    })
  }
  /**
   * Testa a conexão (X-04).
   *
   * O resultado fica NA LINHA da integração, e não numa faixa no topo: quem
   * testou três integrações precisa saber qual delas respondeu o quê. E o
   * estado `RUNNING` existe para o botão não parecer que não fez nada.
   */
  const test = (item: Integration) => {
    if (busy || tests[item.integration_id] === 'RUNNING') return
    setTests(current => ({ ...current, [item.integration_id]: 'RUNNING' }))
    void (async () => {
      try {
        const result = await api.testIntegration(item.integration_id)
        setTests(current => ({ ...current, [item.integration_id]: result }))
      } catch (error) {
        // A falha da CHAMADA não é a falha da integração. Guardar isto como
        // `FAILED` diria que o servidor da pessoa respondeu mal, quando o que
        // aconteceu foi o Studio não conseguir perguntar.
        setTests(current => {
          const { [item.integration_id]: _dropped, ...rest } = current
          return rest
        })
        report(error)
      }
    })()
  }

  /**
   * Remove (X-04). Destrutivo, e por isso passa pela mesma confirmação de
   * ligar — mais uma pergunta em texto claro antes de qualquer coisa sair.
   */
  const remove = (item: Integration) => {
    if (item.enabled) return
    const tier = item.requires_approval_tier
    notify(null)
    if (tier === null || tier === undefined) {
      // Sem nível a confirmar, a pergunta ainda é feita: apagar um registro é
      // uma coisa que ninguém quer descobrir que fez sem querer.
      if (!window.confirm(fill(t.integrations.removeConfirm, { name: item.name }))) return
      return void run(async () => {
        const removed = await api.removeIntegration(item.integration_id)
        announceRemoval(removed)
      })
    }
    void ask({
      tier, action: 'integration.removed', subjectId: item.integration_id,
      describe: decided => fill(t.integrations.needsApproval, { tier: tierLabel(decided) }),
      run: async approval => { announceRemoval(await api.removeIntegration(item.integration_id, approval)) },
    })
  }

  /**
   * O que a tela diz depois de remover.
   *
   * Duas frases, e as duas importam: o histórico do que ela fez CONTINUA
   * guardado (remover a integração não apaga a auditoria), e a referência de
   * segredo deixou de ser usada mas NÃO foi apagada do cofre — o Studio nunca
   * teve permissão de apagar de lá, e deixar isso implícito faria alguém
   * acreditar que a credencial sumiu.
   */
  const announceRemoval = (removed: RemovedIntegration) => {
    setTests(current => {
      const { [removed.integration_id]: _dropped, ...rest } = current
      return rest
    })
    const secret = removed.secret_ref === null ? '' : ` ${fill(t.integrations.removedSecret, { ref: removed.secret_ref })}`
    notify({ kind: 'ok', text: `${fill(t.integrations.removed, { name: removed.name })}${secret}` })
  }

  const confirm = () => {
    const step = pending
    if (step === null) return
    setPending(null)
    void run(async () => {
      const outcome = await step.confirm()
      // The server now demands MORE than the box said (the record changed while the person read it):
      // nothing was done, and the same action is asked again at the level it really costs.
      if (outcome.kind === 'tier-changed') { setPending(outcome.step); notify({ kind: 'info', text: t.confirm.changed }) }
    })
  }
  return <section className="hub-card" aria-labelledby="hub-integrations-title">
    <div className="hub-card-heading"><Plug aria-hidden="true" /><h2 id="hub-integrations-title">{t.integrations.title}</h2></div>
    <p className="hub-help">{t.integrations.help}</p>
    {page?.channel === 'dev' ? <p className="hub-state hub-channel" data-testid="hub-channel">{t.integrations.devChannel}</p> : null}
    <form className="hub-search" role="search" onSubmit={event => { event.preventDefault(); setQuery(current => ({ ...current, search: draft })) }}>
      <label htmlFor="hub-search">{t.integrations.searchLabel}</label>
      <input id="hub-search" type="search" value={draft} onChange={event => setDraft(event.target.value)} placeholder={t.integrations.searchPlaceholder} aria-describedby="hub-search-help" autoComplete="off" />
      <p className="hub-help" id="hub-search-help">{t.integrations.searchHelp}</p>
      <label htmlFor="hub-filter-kind">{t.integrations.kindLabel}</label>
      <select id="hub-filter-kind" value={query.kind} onChange={event => setQuery(current => ({ ...current, kind: event.target.value as KindFilter }))}>
        <option value="all">{t.integrations.anyKind}</option>
        <option value="skill">{kindLabel('skill')}</option>
        <option value="mcp">{kindLabel('mcp')}</option>
        <option value="webhook">{kindLabel('webhook')}</option>
      </select>
      <label htmlFor="hub-filter-status">{t.integrations.statusLabel}</label>
      <select id="hub-filter-status" value={query.status} onChange={event => setQuery(current => ({ ...current, status: event.target.value as StatusFilter }))}>
        <option value="all">{t.integrations.anyStatus}</option>
        <option value="enabled">{t.integrations.onlyEnabled}</option>
        <option value="disabled">{t.integrations.onlyDisabled}</option>
      </select>
      <button type="submit" className="secondary"><Search aria-hidden="true" />{t.integrations.search}</button>
      <button type="button" className="secondary" onClick={() => { setDraft(''); setQuery({ search: '', kind: 'all', status: 'all' }) }}>{t.integrations.clearFilters}</button>
    </form>
    <IntegrationCatalogList
      rows={rows} page={page} search={query.search} busy={busy} loadingMore={loadingMore}
      onEnable={enable}
      onDisable={item => void run(() => api.setEnabled(item.integration_id, false).then(() => undefined))}
      onTest={test}
      onRemove={remove}
      tests={tests}
      onMore={() => void more()}
    />
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
    <ConfirmStep pending={pending} busy={busy} onCancel={() => setPending(null)} onConfirm={confirm} />
  </section>
}

export interface IntegrationCatalogListProps {
  readonly rows: Integration[] | null
  readonly page: Pick<IntegrationCatalog, 'total' | 'matched' | 'next_cursor'> | null
  /** O termo que produziu esta lista, para o vazio poder citá-lo de volta. */
  readonly search: string
  readonly busy: boolean
  readonly loadingMore: boolean
  onEnable(item: Integration): void
  onDisable(item: Integration): void
  /** X-04: abre a conexão, lê o catálogo e fecha — sem executar ferramenta nenhuma. */
  onTest(item: Integration): void
  /** X-04: só oferecido com a integração DESLIGADA. */
  onRemove(item: Integration): void
  onMore(): void
  /** O que o último teste disse, por integração. Ausente = ninguém testou ainda. */
  readonly tests: Readonly<Record<string, IntegrationTestResult | 'RUNNING'>>
}

/**
 * A parte visível do catálogo, pura.
 *
 * Separada para que o vazio, a contagem, a saúde e o "carregar mais" sejam
 * prováveis sem depender de quando a leitura assíncrona termina — é aí que
 * defeitos de rótulo e de estado vazio passam despercebidos.
 */
export function IntegrationCatalogList({ rows, page, search, busy, loadingMore, onEnable, onDisable, onTest, onRemove, onMore, tests }: IntegrationCatalogListProps) {
  // Terceiro estado, antes da primeira resposta: afirmar "você não tem nenhuma"
  // sem ter lido nada seria mentir sobre o que a pessoa registrou.
  if (rows === null || page === null) return <p>{t.loading}</p>
  const empty = catalogEmptyMessage(page, search)
  if (empty !== null) return <p className="hub-empty" data-testid="catalog-empty">{empty}</p>
  const count = catalogCount(rows.length, page)
  return <>
    {count === null ? null : <p className="hub-state" data-testid="catalog-count" role="status">{count}</p>}
    <ul className="hub-list" data-testid="integration-list">
      {rows.map(item => <li key={item.integration_id} data-testid="integration-item">
        <div><strong>{item.name}</strong><span className="hub-meta">{kindLabel(item.kind)}</span></div>
        <div className="hub-tags"><span className={`hub-tag ${item.verification}`}>{verificationLabel(item.verification)}</span><span className="hub-tag">{tierLabel(item.effective_tier)}</span><span className={`hub-tag ${item.enabled ? 'on' : 'off'}`}>{item.enabled ? t.integrations.enabled : t.integrations.disabled}</span></div>
        <IntegrationHealthFacts health={item.health} />
        {item.enabled
          ? <button type="button" className="secondary" disabled={busy} onClick={() => onDisable(item)}>{t.integrations.disable}</button>
          : <>
            {enableExplanation(item) === null ? null : <p className="hub-why" id={`why-${item.integration_id}`}>{enableExplanation(item)}</p>}
            {enableExplanation(item) !== null || approvalNote(item) === null ? null : <p className="hub-why" data-testid="approval-note">{approvalNote(item)}</p>}
            <button type="button" className="primary" disabled={busy || !item.can_enable} aria-describedby={enableExplanation(item) === null ? undefined : `why-${item.integration_id}`} onClick={() => onEnable(item)}>{t.integrations.enable}</button>
          </>}
        {/* X-04. Testar não executa nada do lado de lá; remover só aparece
            habilitado com a integração DESLIGADA, e a frase diz por quê — um
            botão apagado sem explicação vira "o produto travou". */}
        <div className="hub-lifecycle">
          <button type="button" className="secondary" data-testid="integration-test" disabled={busy || tests[item.integration_id] === 'RUNNING'}
            onClick={() => onTest(item)}>{tests[item.integration_id] === 'RUNNING' ? t.integrations.testing : t.integrations.test}</button>
          <button type="button" className="secondary" data-testid="integration-remove" disabled={busy || item.enabled}
            onClick={() => onRemove(item)}>{t.integrations.remove}</button>
        </div>
        {item.enabled ? <p className="hub-why" data-testid="remove-blocked">{t.integrations.removeDisabledWhileOn}</p> : null}
        {testMessage(tests[item.integration_id])}
      </li>)}
    </ul>
    {page.next_cursor === null ? null : <button type="button" className="secondary" data-testid="catalog-more" disabled={loadingMore} onClick={onMore}>{t.integrations.loadMore}</button>}
  </>
}

/**
 * O que o último teste disse, na tela.
 *
 * `NOT_APPLICABLE` sai com o mesmo peso visual de um aviso, e não de erro: uma
 * habilidade que não tem com quem conectar não falhou em nada. E enquanto o
 * teste corre a tela não afirma nada sobre o resultado.
 * @param result - o desfecho guardado, quando existe.
 * @returns o parágrafo, ou nada quando ninguém testou.
 */
function testMessage(result: IntegrationTestResult | 'RUNNING' | undefined) {
  if (result === undefined || result === 'RUNNING') return null
  const kind = result.result === 'OK' ? 'ok' : result.result === 'FAILED' || result.result === 'TIMEOUT' ? 'error' : 'info'
  return <p className={`hub-test ${kind}`} data-testid="integration-test-result" role="status">{result.message}</p>
}

/**
 * A saúde de uma integração em palavras.
 *
 * Um Studio que ainda não publica saúde não vira "OK" aqui: sem o dado a tela
 * não escreve nada, porque afirmar que está tudo bem sem ter medido é
 * exatamente a mentira que este bloco existe para não contar.
 */
function IntegrationHealthFacts({ health }: { health: Integration['health'] }) {
  if (health === undefined) return null
  return <dl className="hub-facts" data-testid="integration-health">
    <dt>{t.integrations.healthTitle}</dt>
    <dd><span className={`hub-tag health-${health.state}`}>{healthLabel(health.state)}</span> {healthCounts(health)}</dd>
    <dt>{t.integrations.costTitle}</dt>
    <dd>{costLabel(health)}</dd>
  </dl>
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
