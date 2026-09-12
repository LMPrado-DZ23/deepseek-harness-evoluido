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
  /**
   * Acrescenta uma etapa descrita em português.
   *
   * OPCIONAL para a tela continuar desenhando numa instalação cujo servidor
   * ainda não tem a rota: sem ele o bloco não aparece, em vez de aparecer um
   * botão que responde 404 na cara de quem não programa.
   */
  addSlice?(request: string): Promise<void>
  /**
   * O que o Studio consultou para montar este plano.
   *
   * OPCIONAL pelo mesmo motivo de `addSlice`: numa instalação cujo servidor
   * ainda não devolve o bloco, o painel não aparece — em vez de aparecer vazio
   * e sugerir que o Studio não consultou nada.
   */
  readonly consulted?: ConsultedView
}

/** O que o servidor conta sobre o que entrou no pedido. */
export interface ConsultedView {
  readonly used: readonly { readonly label: string; readonly source: string }[]
  readonly dropped: readonly { readonly label: string; readonly source: string }[]
  readonly refusedSkills: readonly { readonly label: string; readonly source: string }[]
  readonly incompleteCode: boolean
}

/**
 * O painel do que o Studio consultou.
 *
 * A ordem das seções é deliberada e não é estética: primeiro o que ENTROU
 * (para a pessoa reconhecer o próprio pedido), depois o que NÃO COUBE (que é a
 * informação que muda o julgamento dela sobre o plano), e por último as
 * habilidades recusadas (que são sobre a instalação, não sobre o plano).
 *
 * As duas últimas só aparecem quando têm conteúdo: uma seção vazia repetida em
 * toda tela ensina a pessoa a não olhar para ela.
 * @param props - o que o servidor contou.
 * @returns o painel.
 */
export function ConsultedPanel({ consulted }: { readonly consulted: ConsultedView }) {
  const algoFaltou = consulted.dropped.length > 0 || consulted.incompleteCode
  return <details className="plan-consulted">
    <summary>{t.plan.consultedTitle}</summary>
    <p>{t.plan.consultedHelp}</p>
    <ul className="plan-consulted-used">
      {consulted.used.map((item, index) => <li key={`${item.label}-${String(index)}`}>{item.label}</li>)}
    </ul>
    {/* O aviso vem ANTES da lista do que faltou: quem lê precisa saber que a
        lista tem consequência antes de ler os itens dela. */}
    {algoFaltou ? <p role="alert" className="plan-consulted-gap">{t.plan.consultedIncomplete}</p> : null}
    {consulted.dropped.length > 0 ? <ul className="plan-consulted-dropped">
      {consulted.dropped.map((item, index) => <li key={`${item.label}-${String(index)}`}>{item.label}</li>)}
    </ul> : null}
    {consulted.refusedSkills.length > 0 ? <>
      <h3>{t.plan.consultedSkillsTitle}</h3>
      <ul className="plan-consulted-skills">
        {consulted.refusedSkills.map((item, index) => <li key={`${item.source}-${String(index)}`}>{item.label}</li>)}
      </ul>
    </> : null}
  </details>
}

interface Draft { readonly title: string; readonly description: string; readonly criteriaText: string }

export function PlanEditor({ plan, submit, approve, reason, setReason, requestChange, addSlice, consulted }: PlanEditorProps) {
  const [editing, setEditing] = useState<string | null>(null)
  const [addition, setAddition] = useState('')
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
    {consulted === undefined ? null : <ConsultedPanel consulted={consulted} />}
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
    {/* Acrescentar uma etapa.
        Antes disto o editor sabia mudar, tirar e reordenar — e não sabia
        ACRESCENTAR. Quem quisesse algo fora do plano tinha de pedir uma
        mudança em texto livre e recebia um plano inteiro novo, perdendo junto
        todos os títulos e critérios que já tinha ajustado à mão.
        Os arquivos não aparecem aqui, e a tela DIZ isso: `planned_files` é a
        autorização de escrita do gerador, e um campo de formulário que a
        alimentasse viraria escrita arbitrária no espaço de trabalho. */}
    {addSlice === undefined ? null : <section className="task-card">
      <h2>{t.plan.addTitle}</h2>
      <label htmlFor="plan-add">{t.plan.addLabel}</label>
      <textarea id="plan-add" value={addition} onChange={event => setAddition(event.target.value)} placeholder={t.plan.addPlaceholder} />
      <p className="context-note">{t.plan.addNote}</p>
      <PendingButton className="secondary" label={t.plan.addAction} busyLabel={t.plan.addBusy}
        disabled={addition.trim().length < 3}
        action={async () => { await addSlice(addition.trim()); setAddition('') }} />
    </section>}
    <section className="task-card">
      <h2>{t.plan.change}</h2>
      <label htmlFor="change-reason">{t.plan.changeLabel}</label>
      <textarea id="change-reason" value={reason} onChange={event => setReason(event.target.value)} placeholder={t.plan.changePlaceholder} />
      <PendingButton className="secondary" label={t.plan.sendChange} busyLabel={t.plan.sendChangeBusy} disabled={reason.trim().length < 3} action={requestChange} />
    </section>
  </>
}

export { viewRevision }
