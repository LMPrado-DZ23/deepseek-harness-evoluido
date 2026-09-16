import { STUDIO_CATEGORIES, type Category } from '../categories'
import { PendingButton } from '../PendingButton'
import { creationBlocked, privacyNotice, routeReasonNotice, type PrivacyProfile } from '../presentation'
import { APARENCIAS, PERFIS_PRIVACIDADE, atalhosDaHome, temMaisAtalhos, type CategoryBasis, type DesignPreset } from './opcoes'
import t from '../i18n/pt-BR.json'
import home from '../i18n/home.pt-BR.json'

export interface HomeScreenProps {
  readonly brief: string
  setBrief(v: string): void
  readonly privacy: PrivacyProfile
  setPrivacy(v: PrivacyProfile): void
  readonly route: string | null
  readonly localRoute: string | null | undefined
  readonly routeReason: string | null
  readonly ready: boolean
  chooseSuggestion(v: string, c: Category): void
  readonly category: Category
  readonly categoryBasis: CategoryBasis
  chooseCategory(v: Category): void
  create(): Promise<void>
  readonly designPreset: DesignPreset
  setDesignPreset(v: DesignPreset): void
  readonly brandColor: string
  setBrandColor(v: string): void
  readonly font: 'geist-sans' | 'source-serif'
  setFont(v: 'geist-sans' | 'source-serif'): void
  readonly radius: 'compact' | 'balanced' | 'rounded'
  setRadius(v: 'compact' | 'balanced' | 'rounded'): void
  readonly density: 'compact' | 'comfortable'
  setDensity(v: 'compact' | 'comfortable'): void
  readonly tone: 'friendly' | 'formal'
  setTone(v: 'friendly' | 'formal'): void
  readonly logo: File | null
  setLogo(v: File | null): void
  readonly showDesignAdvanced: boolean
  setShowDesignAdvanced(v: boolean): void
  /** Se a lista de atalhos está aberta além dos quatro primeiros. */
  readonly atalhosAbertos: boolean
  setAtalhosAbertos(v: boolean): void
}

/**
 * A home do workspace aprovado.
 *
 * A hierarquia é a da referência (`ref-home.png`): título centrado, compositor
 * amplo, atalhos em pílula — e espaço livre em volta, que a especificação manda
 * PRESERVAR ("não preenchê-lo com gráficos, estatísticas, banners, anúncios,
 * carrosséis ou dezenas de cards").
 *
 * O que mudou em relação à tela de cinco etapas não é a cor: são os NÍVEIS. O
 * que a pessoa precisa para começar — dizer o que quer — está no primeiro
 * nível, sozinho. Tipo, aparência e privacidade continuam existindo inteiros,
 * com os mesmos controles e as mesmas frases, um nível abaixo, em "Ajustes
 * desta tarefa". Nada saiu; o que mudou foi quantas decisões a home cobra antes
 * da primeira palavra.
 *
 * O botão de enviar é um botão com TEXTO, e não a seta redonda da imagem: o
 * `PendingButton` troca o rótulo por um gerúndio enquanto a chamada corre, e
 * uma seta muda não tem onde dizer "Enviando sua ideia…" — que é exatamente o
 * que quem esperou 3 segundos sem resposta precisava ouvir.
 */
export function HomeScreen(props: HomeScreenProps) {
  const semTipo = props.categoryBasis === 'none' && props.brief.trim() !== ''
  return <div className="dz-home">
    <h1 className="dz-home-titulo">{home.tituloInicio} <span>{home.tituloAcento}</span></h1>

    <div className="dz-compositor">
      <label className="sr-only" htmlFor="brief">{home.compositorRotulo}</label>
      <textarea id="brief" maxLength={1000} value={props.brief} rows={4}
        onChange={event => props.setBrief(event.target.value)} placeholder={t.idea.placeholder} />
      <div className="dz-compositor-rodape">
        <span className="dz-contador" aria-live="polite">{props.brief.length} {t.idea.counter}</span>
        <PendingButton label={t.idea.continue} busyLabel={t.idea.continueBusy}
          disabled={!props.ready || creationBlocked(props.privacy, props.localRoute)} action={props.create} />
      </div>
    </div>

    <div className="dz-atalhos" role="group" aria-label={home.atalhosRotulo}>
      {atalhosDaHome(props.atalhosAbertos).map(atalho => <button key={atalho.categoria} type="button"
        className="dz-atalho" onClick={() => props.chooseSuggestion(atalho.texto, atalho.categoria)}>
        <span>{t.idea.kinds[atalho.categoria]}</span>
        {atalho.inicial ? <span className="badge-beta">{t.idea.betaBadge}</span> : null}
      </button>)}
      {temMaisAtalhos() ? <button type="button" className="dz-atalho dz-atalho-mais"
        aria-expanded={props.atalhosAbertos} onClick={() => props.setAtalhosAbertos(!props.atalhosAbertos)}>
        {props.atalhosAbertos ? home.menos : home.mais}
      </button> : null}
    </div>
    <p className="dz-home-aviso">{t.idea.betaNotice}</p>

    {/*
      O seletor de tipo vem ABERTO quando o texto não deixou o tipo claro:
      esconder a única pergunta que ainda falta atrás de um resumo fechado é a
      mesma armadilha do seletor pré-preenchido, com outra fantasia.
    */}
    <details className="dz-ajustes" open={semTipo}>
      <summary>{home.ajustes}</summary>
      <p className="coming">{home.ajustesDetalhe}</p>

      <h2>{t.idea.kindTitle}</h2>
      <p className="coming">{props.categoryBasis === 'text' ? t.idea.kindHelp
        : props.categoryBasis === 'trade' ? t.idea.kindHelpTrade
          : props.categoryBasis === 'person' ? t.idea.kindHelpChosen : t.idea.kindHelpUnknown}</p>
      {/* Quando NÃO entendemos, o seletor não vem preenchido.
          Ele vinha: `landing-page` é o valor padrão do palpite, e sai igual
          quando o texto fala de página e quando o texto não diz nada que a
          gente reconheça. Quem não lê a frase de ajuda aceita o que está na
          tela — e recebe uma página de apresentação depois de esperar a criação
          inteira, tendo pedido outra coisa. */}
      <label className="kind">{t.idea.kindLabel}
        <select value={semTipo ? '' : props.category} onChange={event => props.chooseCategory(event.target.value as Category)}>
          {semTipo ? <option value="">{t.idea.kindChoose}</option> : null}
          {STUDIO_CATEGORIES.map(value => <option key={value} value={value}>{t.idea.kinds[value]}</option>)}
        </select>
      </label>
      {semTipo ? <p className="error" role="status">{t.idea.kindRequired}</p> : null}

      <h2>{t.design.title}</h2><p className="coming">{t.design.subtitle}</p>
      <div className="design-grid">{APARENCIAS.map(([value, label, detail]) => <button type="button" key={value}
        className={props.designPreset === value ? 'design-card selected' : 'design-card'}
        aria-pressed={props.designPreset === value} onClick={() => props.setDesignPreset(value)}>
        <strong>{label}</strong><span>{detail}</span>
      </button>)}</div>
      <button type="button" className="advanced" aria-expanded={props.showDesignAdvanced}
        onClick={() => props.setShowDesignAdvanced(!props.showDesignAdvanced)}>
        {props.showDesignAdvanced ? t.design.hideAdvanced : t.design.advanced}
      </button>
      {props.showDesignAdvanced ? <section className="design-advanced">
        {props.designPreset === 'brand' ? <label>{t.design.primaryColor}<input type="color" value={props.brandColor} onChange={event => props.setBrandColor(event.target.value)} /></label> : null}
        <label>{t.design.font}<select value={props.font} onChange={event => props.setFont(event.target.value as typeof props.font)}><option value="geist-sans">{t.design.fontSans}</option><option value="source-serif">{t.design.fontSerif}</option></select></label>
        <label>{t.design.radius}<select value={props.radius} onChange={event => props.setRadius(event.target.value as typeof props.radius)}><option value="compact">{t.design.radiusCompact}</option><option value="balanced">{t.design.radiusBalanced}</option><option value="rounded">{t.design.radiusRounded}</option></select></label>
        <label>{t.design.density}<select value={props.density} onChange={event => props.setDensity(event.target.value as typeof props.density)}><option value="compact">{t.design.densityCompact}</option><option value="comfortable">{t.design.densityComfortable}</option></select></label>
        <label>{t.design.tone}<select value={props.tone} onChange={event => props.setTone(event.target.value as typeof props.tone)}><option value="friendly">{t.design.toneFriendly}</option><option value="formal">{t.design.toneFormal}</option></select></label>
        <label>{t.design.logo}<input type="file" accept="image/png,image/jpeg" onChange={event => props.setLogo(event.target.files?.[0] ?? null)} /></label><small>{props.logo === null ? t.design.logoHelp : props.logo.name}</small>
      </section> : null}

      <fieldset className="privacy-profiles"><legend>{t.privacy.title}</legend>
        {PERFIS_PRIVACIDADE.map(([value, label, detail]) => <label key={value}>
          <input type="radio" name="privacy-profile" checked={props.privacy === value} onChange={() => props.setPrivacy(value)} />
          <strong>{label}</strong><span>{detail}</span>
        </label>)}
      </fieldset>
      <p className="privacy-notice">{privacyNotice(props.privacy, props.route, t.privacy, props.localRoute)}</p>
      {routeReasonNotice(props.privacy, props.routeReason, t.privacy.reasons) === null ? null
        : <p className="privacy-notice">{t.privacy.routeReason} {routeReasonNotice(props.privacy, props.routeReason, t.privacy.reasons)}</p>}
    </details>

    <p className="context-note">{t.truth.idea}</p>
  </div>
}
