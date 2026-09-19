import { Download, RefreshCw, Upload } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { csrfToken } from '../api'
import copy from '../i18n/assistant.pt-BR.json'

/**
 * A PASTA DE TRABALHO do agente geral: o que a pessoa manda, e o que ele
 * produz, com download. Qualquer tipo de arquivo, até 50 MB (o servidor
 * confere; ver `plugins/studio-web/src/assistant-files.ts`).
 */
export interface ArquivoDaPasta { readonly caminho: string; readonly bytes: number; readonly alterado_em: string }

export const ROTA_DOS_ARQUIVOS = '/studio/assistant/files'
export const ROTA_DE_BAIXAR = '/studio/assistant/files/baixar'

export function tamanhoLegivel(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`
}

export function enderecoParaBaixar(caminho: string): string {
  return `${ROTA_DE_BAIXAR}?caminho=${encodeURIComponent(caminho)}`
}

export function PastaDeTrabalho({ buscar = fetch, obterCsrf = csrfToken }: { readonly buscar?: typeof fetch; readonly obterCsrf?: () => Promise<string> }) {
  const [arquivos, setArquivos] = useState<readonly ArquivoDaPasta[] | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)
  const seletor = useRef<HTMLInputElement>(null)

  const atualizar = useCallback(async () => {
    const resposta = await buscar(ROTA_DOS_ARQUIVOS, { credentials: 'same-origin' })
    const corpo = await resposta.json().catch(() => null) as { arquivos?: ArquivoDaPasta[]; error?: string } | null
    if (!resposta.ok) { setArquivos([]); setAviso(corpo?.error ?? copy.pastaIndisponivel); return }
    setArquivos(corpo?.arquivos ?? [])
  }, [buscar])

  useEffect(() => { void atualizar() }, [atualizar])

  const enviar = async (arquivo: File) => {
    setEnviando(true); setAviso(null)
    try {
      const resposta = await buscar(`${ROTA_DOS_ARQUIVOS}?nome=${encodeURIComponent(arquivo.name)}`, {
        method: 'POST', credentials: 'same-origin', body: arquivo,
        headers: { 'content-type': 'application/octet-stream', 'x-dz23-csrf': await obterCsrf() },
      })
      const corpo = await resposta.json().catch(() => null) as { caminho?: string; error?: string } | null
      setAviso(resposta.ok ? copy.pastaEnviado.replace('{caminho}', corpo?.caminho ?? arquivo.name) : corpo?.error ?? copy.pastaFalhou)
      await atualizar()
    } finally { setEnviando(false) }
  }

  return <section className="pasta-de-trabalho" aria-labelledby="pasta-titulo">
    <header>
      <h2 id="pasta-titulo">{copy.pastaTitulo}</h2>
      <p className="context-note">{copy.pastaExplica}</p>
    </header>
    <div className="pasta-acoes">
      <input ref={seletor} type="file" className="sr-only" tabIndex={-1} aria-hidden="true"
        onChange={event => { const arquivo = event.target.files?.[0]; event.target.value = ''; if (arquivo !== undefined) void enviar(arquivo) }} />
      <button type="button" className="secondary" disabled={enviando} onClick={() => seletor.current?.click()}>
        <Upload aria-hidden="true" /> {enviando ? copy.pastaEnviando : copy.pastaEnviar}
      </button>
      <button type="button" className="secondary" onClick={() => { void atualizar() }}>
        <RefreshCw aria-hidden="true" /> {copy.pastaAtualizar}
      </button>
    </div>
    {aviso === null ? null : <p className="context-note" role="status">{aviso}</p>}
    {arquivos === null ? null : arquivos.length === 0
      ? <p className="context-note">{copy.pastaVazia}</p>
      : <ul className="pasta-lista">
          {arquivos.map(arquivo => <li key={arquivo.caminho}>
            <a href={enderecoParaBaixar(arquivo.caminho)} download aria-label={copy.pastaBaixar.replace('{caminho}', arquivo.caminho)}>
              <Download aria-hidden="true" /> <span>{arquivo.caminho}</span>
            </a>
            <span className="context-note">{tamanhoLegivel(arquivo.bytes)}</span>
          </li>)}
        </ul>}
  </section>
}
