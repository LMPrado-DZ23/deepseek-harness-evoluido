import { ArrowLeft, Clock } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import copy from '../i18n/destinos.pt-BR.json'
import hubCopy from '../i18n/hub.pt-BR.json'
import { HubPanel } from '../hub/HubPanel'
import { operacoesDaBiblioteca, tiposDaBiblioteca } from './biblioteca'
import { previaDoPacote, type EntradaDoPacote } from './previa'

/*
  O cliente do Hub, criado UMA VEZ.

  Ele era `api = createHubApi()` no valor padrão do parâmetro, e isso produzia
  um objeto NOVO a cada render. `ler` depende dele, o efeito depende de `ler`, e
  o efeito chama `setAcervo` — então cada render disparava outra leitura, que
  disparava outro render. MEDIDO no navegador antes do conserto: 621 chamadas a
  `/exports` em 3 segundos, numa tela parada.

  O defeito não aparecia porque a tela desenhava certo. Ele só cobrava a conta
  do servidor, da bateria e da rede de quem estivesse com a Biblioteca aberta.
*/
const clienteDoHub = createHubApi()
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
export function BibliotecaScreen({ api = clienteDoHub }: { readonly api?: HubApi } = {}) {
  const [projetos, setProjetos] = useState<ProjectSummary[] | null>(null)
  const [acervo, setAcervo] = useState<readonly ItemDoAcervo[] | null>(null)
  const [filtro, setFiltro] = useState<string>('todas')
  /*
    A prévia ABERTA, por pacote. `null` é nenhuma aberta; dentro dela, `null` em
    `entradas` é "ainda lendo", que é diferente de "não tem nada".
  */
  const [previa, setPrevia] = useState<{ readonly exportId: string, readonly entradas: readonly EntradaDoPacote[] | null, readonly erro: string | null } | null>(null)
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

  /**
   * Abre — ou fecha — a prévia de um pacote.
   * @param projectId - a tarefa dona do pacote.
   * @param exportId - o pacote.
   */
  async function abrirPrevia(projectId: string, exportId: string) {
    if (previa?.exportId === exportId) { setPrevia(null); return }
    setPrevia({ exportId, entradas: null, erro: null })
    try {
      const entradas = await api.exportPreview(projectId, exportId)
      setPrevia({ exportId, entradas, erro: null })
    } catch (erro) {
      // A recusa do servidor é uma frase pronta em português — pacote grande
      // demais, pacote ilegível. Ela é mostrada como veio, e o download
      // continua ali do lado.
      setPrevia({ exportId, entradas: null, erro: erro instanceof Error ? erro.message : copy.previaFalhou })
    }
  }

  const mostrados = acervo === null ? null
    : filtro === 'todas' ? acervo : acervo.filter(item => item.projeto.project_id === filtro)

  return <main className="dz-destino">
    <header className="dz-destino-topo">
      <a className="dz-destino-voltar" href={STUDIO_HOME_PATH}><ArrowLeft aria-hidden="true" /><span>{copy.voltar}</span></a>
      <div><h1>{copy.bibliotecaTitulo}</h1><p>{copy.bibliotecaSubtitulo}</p></div>
    </header>

    {falhou ? <p className="error" role="alert">{copy.bibliotecaFalhou}</p> : null}

    {/*
      A DECLARAÇÃO, exigida pelo proprietário: "a Biblioteca precisa declarar
      exatamente quais arquivos e operações ela suporta". Ela vem de
      `biblioteca.ts`, que tem teste — um parágrafo escrito à mão aqui
      envelheceria sem ninguém notar, e a promessa passaria a ser falsa.
    */}
    <section className="dz-biblioteca-declaracao" aria-labelledby="dz-biblioteca-declaracao-titulo">
      <h2 id="dz-biblioteca-declaracao-titulo">{copy.bibliotecaDeclaracao}</h2>
      <p><strong>{copy.bibliotecaTiposRotulo}:</strong> {tiposDaBiblioteca().map(tipo => copy.bibliotecaTipos[tipo as keyof typeof copy.bibliotecaTipos]).join('; ')}</p>
      <div className="dz-biblioteca-colunas">
        <div>
          <h3>{copy.bibliotecaFazRotulo}</h3>
          <ul>
            {operacoesDaBiblioteca().filter(operacao => operacao.suportada).map(operacao =>
              <li key={operacao.id}>{copy.bibliotecaOperacoes[operacao.id as keyof typeof copy.bibliotecaOperacoes]}</li>)}
          </ul>
        </div>
        <div>
          <h3>{copy.bibliotecaNaoFazRotulo}</h3>
          <ul>
            {operacoesDaBiblioteca().filter(operacao => !operacao.suportada).map(operacao => <li key={operacao.id}>
              <span>{copy.bibliotecaOperacoes[operacao.id as keyof typeof copy.bibliotecaOperacoes]}</span>
              <span className="dz-biblioteca-motivo">{copy.bibliotecaMotivos[operacao.motivo as keyof typeof copy.bibliotecaMotivos]}</span>
            </li>)}
          </ul>
        </div>
      </div>
    </section>

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
              <p className="dz-acervo-acoes">
                {/*
                  VER O QUE TEM DENTRO — sem baixar. É a operação que a
                  declaração acima dizia que faltava, e que agora existe.
                */}
                <button type="button" className="dz-acervo-abrir"
                  aria-expanded={previa?.exportId === item.registro.export_id}
                  onClick={() => { void abrirPrevia(item.projeto.project_id, item.registro.export_id) }}>
                  {/*
                    O RÓTULO NÃO MUDA, e o estado vai em `aria-expanded`.

                    Trocar o texto para "Fechar" quando abre parece natural e é
                    pior: quem ouve a tela recebe a mesma informação duas vezes
                    e perde a referência do que aquele botão controla. O padrão
                    ARIA de divulgação é exatamente este — nome estável, estado
                    no atributo.
                  */}
                  {copy.previaAbrir}
                </button>
                <a className="dz-acervo-baixar" href={api.downloadHref(item.projeto.project_id, item.registro.export_id)}>{hubCopy.exports.download}</a>
              </p>
              {previa?.exportId !== item.registro.export_id ? null : <PreviaDoPacote previa={previa} />}
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

/** A lista do que há dentro de um pacote. */
function PreviaDoPacote({ previa }: {
  readonly previa: { readonly entradas: readonly EntradaDoPacote[] | null, readonly erro: string | null }
}) {
  if (previa.erro !== null) return <p className="dz-previa-erro" role="status">{previa.erro}</p>
  // Três estados, e não dois: ainda lendo, leu e está vazio, leu e tem coisas.
  if (previa.entradas === null) return <p className="dz-previa-lendo" role="status">{copy.previaLendo}</p>
  const montada = previaDoPacote(previa.entradas)
  if (montada.total === 0) return <p className="dz-previa-vazio">{copy.previaVazio}</p>
  return <div className="dz-previa">
    <p className="dz-previa-total">{copy.previaTotal.replace('{quantos}', String(montada.total))}</p>
    <ul className="dz-previa-itens">
      {montada.entradas.map(entrada => <li key={entrada.name}>
        <span className="dz-previa-nome">{entrada.name}</span>
        <span className="dz-previa-tamanho">{formatBytes(entrada.size)}</span>
      </li>)}
    </ul>
    {montada.restantes > 0 ? <p className="dz-previa-restantes">{copy.previaRestantes.replace('{quantos}', String(montada.restantes))}</p> : null}
  </div>
}
