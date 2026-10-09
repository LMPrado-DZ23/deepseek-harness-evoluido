/**
 * O controle da pessoa sobre o WebMCP.
 *
 * DESLIGADO por padrão, e a tela diz exatamente o que fica exposto e a quem.
 * Um recurso que entrega poder de ação a um programa de terceiro não pode
 * chegar ligado "para facilitar": quem liga tem que ter lido o que está
 * ligando.
 */
import { useEffect, useState } from 'react'
import t from '../i18n/pt-BR.json'
import { studioTools, type StudioPort } from './tools'

export const WEBMCP_STORAGE_KEY = 'dz23.studio.webmcp.v1'

/**
 * Se a pessoa ligou, neste navegador.
 *
 * Ausente vale como DESLIGADO, e uma leitura que falha também: um armazenamento
 * bloqueado não pode ser lido como consentimento.
 */
export function webMcpEnabled(storage: Pick<Storage, 'getItem'> | undefined): boolean {
  try { return storage?.getItem(WEBMCP_STORAGE_KEY) === 'on' } catch { return false }
}

export function setWebMcpEnabled(storage: Pick<Storage, 'setItem'> | undefined, enabled: boolean): void {
  try { storage?.setItem(WEBMCP_STORAGE_KEY, enabled ? 'on' : 'off') } catch { /* nada a fazer: fica desligado */ }
}

export interface WebMcpPanelProps {
  /** `false` quando este navegador não oferece `document.modelContext`. */
  readonly available: boolean
  readonly enabled: boolean
  setEnabled(value: boolean): void
  readonly port: StudioPort
}

export function WebMcpPanel({ available, enabled, setEnabled, port }: WebMcpPanelProps) {
  const [tools] = useState(() => studioTools(port))
  return <section className="task-card" aria-labelledby="webmcp-title">
    <h2 id="webmcp-title">{t.webmcp.title}</h2>
    <p>{t.webmcp.what}</p>
    {available
      ? <>
        <label className="webmcp-toggle">
          <input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />
          <span>{t.webmcp.toggle}</span>
        </label>
        <p className="webmcp-state" role="status">{enabled ? t.webmcp.on : t.webmcp.off}</p>
      </>
      : <p className="webmcp-state">{t.webmcp.unavailable}</p>}
    <h3>{t.webmcp.exposedTitle}</h3>
    <ul>{tools.map(tool => <li key={tool.name}><strong>{tool.name}</strong> — {tool.description}</li>)}</ul>
    <h3>{t.webmcp.neverTitle}</h3>
    <p>{t.webmcp.never}</p>
  </section>
}

/**
 * Lê o estado guardado uma vez e devolve o par para a tela.
 *
 * Em efeito, e não no primeiro desenho, porque a leitura de armazenamento pode
 * lançar em janela anônima e em navegador com dados de site bloqueados — e um
 * desenho que lança não mostra nem o texto que explica o recurso.
 */
export function useWebMcpSetting(storage: Storage | undefined): readonly [boolean, (value: boolean) => void] {
  const [enabled, setEnabledState] = useState(false)
  useEffect(() => { setEnabledState(webMcpEnabled(storage)) }, [storage])
  return [enabled, (value: boolean) => { setWebMcpEnabled(storage, value); setEnabledState(value) }]
}
