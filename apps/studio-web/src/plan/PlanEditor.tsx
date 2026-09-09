/**
 * E-03 — a tela do plano, agora editável.
 *
 * A pessoa vê as partes do plano e pode: renomear, reescrever, mexer nos
 * critérios de aceite, tirar uma parte e mudar a ordem. Os ARQUIVOS que serão
 * criados não aparecem como campo: eles são a autorização de escrita do
 * gerador (E-09), e a tela diz isso em uma frase em vez de deixar a ausência
 * parecer esquecimento.
 */
import { useState } from 'react'
import t from '../i18n/pt-BR.json'
import { criteriaToText, moveRequest, removeRequest, sliceEditRequest, viewRevision, type PlanEditRequest, type PlanView } from './planEdit'
import { PendingButton } from '../PendingButton'

export interface PlanEditorProps {
  readonly plan: PlanView
  /** Manda a alteração e devolve o plano gravado. A tela adota o que voltou. */
  submit(edit: PlanEditRequest): Promise<void>
  approve(): Promise<void>
  reason: string
  setReason(value: string): void
  requestChange(): Promise<void>
}

interface Draft { readonly title: string; readonly description: string; readonly criteriaText: string }

export function PlanEditor({ plan, submit, approve, reason, setReason, requestChange }: PlanEditorProps) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>({ title: '', description: '', criteriaText: '' })

  function open(sliceId: string) {
    const slice = plan.slices.find(candidate => candidate.slice_id === sliceId)
    if (slice === undefined) return
    setDraft({ title: slice.title, description: slice.description, criteriaText: criteriaToText(slice.acceptance_criteria) })
    setEditing(sliceId)
  }
  async function save(sliceId: string) {
    const request = sliceEditRequest(plan, sliceId, draft)
    // Nada mudou: fechar sem mandar. Um pedido que não muda nada gastaria uma
    // revisão e faria a outra aba receber "o plano mudou" por engano.
    if (request !== undefined) await submit(request)
    setEditing(null)
  }
  async function send(request: PlanEditRequest | undefined) {
    if (request === undefined) return
    setEditing(null)
    await submit(request)
  }

  return <>
    <div className="heading"><div><h1>{t.plan.title}</h1><p>{t.progress.planDetail}</p></div></div>
    {plan.edited_by_person === true ? <p className="plan-edited">{t.plan.editedByPerson}</p> : null}
    <p className="plan-note">{t.plan.filesFixed}</p>
    <ol className="plan-list" aria-label={t.plan.title}>
      {plan.slices.map((slice, index) => <li className="task-card" key={slice.slice_id}>
        {editing === slice.slice_id
          ? <div className="plan-edit-form">
            <h2>{t.plan.editing}</h2>
            <label htmlFor={`plan-title-${slice.slice_id}`}>{t.plan.editTitle}</label>
            <input id={`plan-title-${slice.slice_id}`} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} />
            <label htmlFor={`plan-description-${slice.slice_id}`}>{t.plan.editDescription}</label>
            <textarea id={`plan-description-${slice.slice_id}`} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} />
            <label htmlFor={`plan-criteria-${slice.slice_id}`}>{t.plan.editCriteria}</label>
            <textarea id={`plan-criteria-${slice.slice_id}`} value={draft.criteriaText} onChange={event => setDraft({ ...draft, criteriaText: event.target.value })} />
            <PendingButton label={t.plan.editSave} busyLabel={t.plan.editSaveBusy} action={() => save(slice.slice_id)} />
            <button className="secondary" onClick={() => setEditing(null)}>{t.plan.editCancel}</button>
          </div>
          : <>
            <h2>{slice.title}</h2>
            <p>{slice.description}</p>
            <strong>{t.plan.criterion}</strong>
            <ul>{slice.acceptance_criteria.map(value => <li key={value}>{value}</li>)}</ul>
            <div className="plan-actions">
              <button className="secondary" onClick={() => open(slice.slice_id)}>{t.plan.edit}</button>
              <PendingButton className="secondary" label={t.plan.remove} busyLabel={t.plan.removeBusy}
                disabled={removeRequest(plan, slice.slice_id) === undefined}
                action={() => send(removeRequest(plan, slice.slice_id))} />
              <PendingButton className="secondary" label={t.plan.moveUp} busyLabel={t.plan.moveBusy}
                disabled={index === 0} ariaLabel={`${t.plan.moveUp}: ${slice.title}`}
                action={() => send(moveRequest(plan, slice.slice_id, 'up'))} />
              <PendingButton className="secondary" label={t.plan.moveDown} busyLabel={t.plan.moveBusy}
                disabled={index === plan.slices.length - 1} ariaLabel={`${t.plan.moveDown}: ${slice.title}`}
                action={() => send(moveRequest(plan, slice.slice_id, 'down'))} />
            </div>
          </>}
      </li>)}
    </ol>
    <PendingButton label={t.plan.approve} busyLabel={t.plan.approveBusy} action={approve} />
    <section className="task-card">
      <h2>{t.plan.change}</h2>
      <label htmlFor="change-reason">{t.plan.changeLabel}</label>
      <textarea id="change-reason" value={reason} onChange={event => setReason(event.target.value)} placeholder={t.plan.changePlaceholder} />
      <PendingButton className="secondary" label={t.plan.sendChange} busyLabel={t.plan.sendChangeBusy} disabled={reason.trim().length < 3} action={requestChange} />
    </section>
  </>
}

export { viewRevision }
