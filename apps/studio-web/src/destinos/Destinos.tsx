import { ArrowLeft, Clock } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import copy from '../i18n/destinos.pt-BR.json'
import hubCopy from '../i18n/hub.pt-BR.json'
import { HubPanel } from '../hub/HubPanel'
import { createHubApi, type ExportRecord, type HubApi, type ProjectSummary } from '../hub/hubApi'
import { formatBytes, formatDate } from '../hub/presentation'
import { STUDIO_HOME_PATH } from '../navigation'
import { DISPONIBILIDADE, ESCOPO } from './destinos'
import './destinos.css'

/**
 * As telas dos destinos que o trilho ganhou: Habilidades, Plugins, Biblioteca
 * e Agendado.
 *
 * As duas primeiras são o MESMO componente do Hub com escopos diferentes —
 * serviço compartilhado, vistas próprias, que é o que a decisão de produto
 * pede. A Biblioteca é o acervo real de pacotes exportados, lido do serviço que
 * já os guardava e que só tinha porta dentro de um cartão do Hub. A última diz
 * a verdade sobre uma função que não existe.
 */

export function HabilidadesScreen({ api }: { readonly api?: HubApi } = {}) {
  return <HubPanel {...(api === undefined ? {} : { api })} escopo={ESCOPO.habilidades}
    titulo={copy.habilidadesTitulo} subtitulo={copy.habilidadesSubtitulo} />
}

export function PluginsScreen({ api }: { readonly api?: HubApi } = {}) {
  return <HubPanel {...(api === undefined ? {} : { api })} escopo={ESCOPO.plugins}
    titulo={copy.pluginsTitulo} subtitulo={copy.pluginsSubtitulo} />
}

/**
 * A Biblioteca: os pacotes que as tarefas produziram.
 *
 * Ela NÃO é a lista de projetos com outro nome, e a diferença não é de rótulo:
 * o que ela lista são artefatos — arquivo, tamanho, resumo criptográfico e data
 * — e cada linha aponta para a tarefa que o produziu, e não o contrário. Uma
 * tarefa sem pacote não aparece aqui; um pacote aparece mesmo depois de a
 * tarefa ter seguido para outra tentativa.
 *
 * A leitura é por tarefa porque é assim que o serviço guarda. Quando não há
 * tarefa nenhuma, a tela diz isso — que é diferente de "nenhum pacote".
 */
export function BibliotecaScreen({ api = createHubApi() }: { readonly api?: HubApi } = {}) {
  const [projetos, setProjetos] = useState<ProjectSummary[] | null>(null)
  const [acervo, setAcervo] = useState<readonly ItemDoAcervo[] | null>(null)
  const [filtro, setFiltro] = useState<string>('todas')
  const [falhou, setFalhou] = useState(false)

  const ler = useCallback(async () => {
    setFalhou(false)
    try {
      const lista = await api.projects()
      setProjetos(lista)
      // Uma leitura por tarefa, em paralelo. Uma tarefa que falhe sozinha não
      // apaga o acervo inteiro: ela entra como ausência, e as outras aparecem.
      const paginas = await Promise.all(lista.map(async projeto => {
        try { return (await api.exports(projeto.project_id)).map(registro => ({ registro, projeto })) }
        catch { return [] as ItemDoAcervo[] }
      }))
      setAcervo(paginas.flat().sort((esquerda, direita) =>
        direita.registro.created_at.localeCompare(esquerda.registro.created_at)))
    } catch { setFalhou(true); setAcervo([]) }
  }, [api])

  useEffect(() => { void ler() }, [ler])

  const mostrados = acervo === null ? null
    : filtro === 'todas' ? acervo : acervo.filter(item => item.projeto.project_id === filtro)

  return <main className="dz-destino">
    <header className="dz-destino-topo">
      <a className="dz-destino-voltar" href={STUDIO_HOME_PATH}><ArrowLeft aria-hidden="true" /><span>{copy.voltar}</span></a>
      <div><h1>{copy.bibliotecaTitulo}</h1><p>{copy.bibliotecaSubtitulo}</p></div>
    </header>

    {falhou ? <p className="error" role="alert">{copy.bibliotecaFalhou}</p> : null}

    {projetos !== null && projetos.length > 1 ? <label className="dz-destino-filtro">
      {copy.bibliotecaFiltroRotulo}
      <select value={filtro} onChange={evento => setFiltro(evento.target.value)}>
        <option value="todas">{copy.bibliotecaTodas}</option>
        {projetos.map(projeto => <option key={projeto.project_id} value={projeto.project_id}>{projeto.name}</option>)}
      </select>
    </label> : null}

    {/* Três estados, e não dois: ainda não li, li e não há tarefa, li e não há
        pacote. Dizer "nenhum pacote" antes de ler é afirmar o que não se sabe. */}
    {mostrados === null ? <p>{copy.bibliotecaCarregando}</p>
      : projetos !== null && projetos.length === 0 ? <p className="dz-destino-vazio">{copy.bibliotecaSemTarefa}</p>
        : mostrados.length === 0 ? <p className="dz-destino-vazio">{copy.bibliotecaVazia}</p>
          : <ul className="dz-acervo">
            {mostrados.map(item => <li key={item.registro.export_id} className="dz-acervo-item">
              <strong>{item.registro.file_name}</strong>
              <p className="dz-acervo-tarefa">{copy.bibliotecaDaTarefa}: {item.projeto.name}</p>
              <dl className="dz-acervo-fatos">
                <div><dt>{hubCopy.exports.size}</dt><dd>{formatBytes(item.registro.size_bytes)}</dd></div>
                <div><dt>{hubCopy.exports.entries}</dt><dd>{item.registro.entries}</dd></div>
                <div><dt>{hubCopy.exports.createdAt}</dt><dd>{formatDate(item.registro.created_at)}</dd></div>
                <div><dt>{hubCopy.exports.digest}</dt><dd><code>{item.registro.sha256}</code></dd></div>
              </dl>
              <a className="dz-acervo-baixar" href={api.downloadHref(item.projeto.project_id, item.registro.export_id)}>{hubCopy.exports.download}</a>
            </li>)}
          </ul>}
  </main>
}

interface ItemDoAcervo {
  readonly registro: ExportRecord
  readonly projeto: ProjectSummary
}

/**
 * Agendado: um destino real para uma função que ainda não existe.
 *
 * A decisão de produto autoriza exatamente isto durante a migração — "uma
 * página de indisponibilidade/diagnóstico verdadeira é permitida" — e diz na
 * mesma frase que ela NÃO satisfaz o aceite funcional. Então esta tela não tem
 * botão mudo, não mostra lista vazia como se fosse um agendamento sem itens, e
 * nomeia o que falta para a função existir.
 */
export function AgendadoScreen() {
  return <main className="dz-destino">
    <header className="dz-destino-topo">
      <a className="dz-destino-voltar" href={STUDIO_HOME_PATH}><ArrowLeft aria-hidden="true" /><span>{copy.voltar}</span></a>
      <div><h1>{copy.agendadoTitulo}</h1><p>{copy.agendadoSubtitulo}</p></div>
    </header>
    <section className="dz-destino-pendente" aria-labelledby="dz-agendado-estado">
      <p id="dz-agendado-estado" className="dz-destino-estado">
        <Clock aria-hidden="true" />
        <span>{copy.agendadoIndisponivel}</span>
      </p>
      <h2>{copy.agendadoOQueFalta}</h2>
      <ul>
        <li>{copy.agendadoFaltaServidor}</li>
        <li>{copy.agendadoFaltaLimite}</li>
      </ul>
      <p className="dz-destino-vazio">{copy.agendadoEnquantoIsso}</p>
    </section>
  </main>
}

/** A pendência declarada em `destinos.ts`, reafirmada onde a tela a usa. */
export const AGENDADO_PENDENTE = DISPONIBILIDADE.agendado === 'pendente'
