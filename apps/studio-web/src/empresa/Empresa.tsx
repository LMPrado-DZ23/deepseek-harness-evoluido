import { ArrowLeft, Building2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import copy from '../i18n/empresa.pt-BR.json'
import { STUDIO_HOME_PATH } from '../navigation'
import { createEmpresaApi, type Empresa, type EmpresaApi, type RegistroDePlano, type VinculoDeTarefa } from './empresaApi'
import { STUDIO_CATEGORIES } from '../categories'
import copyGeral from '../i18n/pt-BR.json'
import {
  RASCUNHO_VAZIO,
  TAREFA_VAZIA,
  planoDoRascunho,
  rascunhoDoPlano,
  recusaDaEmpresa,
  recusaDaRevisao,
  nomesDasTarefas,
  recusaDaTarefa,
  textoNormalizado,
  versaoVigente,
  versoesAnteriores,
  type RascunhoDaEmpresa,
  type RascunhoDaTarefa,
  type RascunhoDoPlano,
} from './empresa'
import './empresa.css'

/*
  O cliente, criado UMA VEZ.

  Um `createEmpresaApi()` no valor padrão do parâmetro produziria um objeto novo
  a cada render; `ler` dependeria dele, o efeito dependeria de `ler`, e o efeito
  chamaria `setEmpresas` — o laço que já custou 621 chamadas em 3 segundos na
  Biblioteca, numa tela parada.
*/
const cliente = createEmpresaApi()

/**
 * Uma chave de intenção de envio, nova a cada envio que COMEÇA.
 *
 * `randomUUID` existe em todo navegador que este produto suporta; o outro ramo
 * é para o desenho no servidor, onde ele pode não existir — e um `throw` ali
 * derrubaria a tela inteira por causa de um valor que nem chega a ser usado.
 * @returns a chave.
 */
function novaChaveDeEnvio(): string {
  const cripto = globalThis.crypto as { randomUUID?: () => string } | undefined
  return cripto?.randomUUID === undefined ? `envio-${String(Date.now())}` : cripto.randomUUID()
}

/** Uma frase de recusa da tela, pela chave. */
function frase(chave: keyof typeof copy | null): string | null {
  return chave === null ? null : copy[chave]
}

/**
 * Os campos do plano, compartilhados pelo cadastro e pela revisão.
 *
 * Exportado para ter teste próprio: a suíte desta aplicação desenha componentes
 * com `renderToStaticMarkup`, e um pedaço de tela que só existe dentro do
 * estado do componente-pai não é alcançado por ela.
 */
export function CamposDoPlano({ rascunho, aoMudar, prefixo }: {
  readonly rascunho: RascunhoDoPlano
  readonly aoMudar: (parcial: Partial<RascunhoDoPlano>) => void
  readonly prefixo: string
}) {
  return <>
    <p className="dz-empresa-campo">
      <label htmlFor={`${prefixo}-objetivo`}>{copy.objetivo}</label>
      <textarea id={`${prefixo}-objetivo`} rows={3} value={rascunho.objetivo}
        onChange={evento => aoMudar({ objetivo: evento.target.value })} />
    </p>
    <p className="dz-empresa-campo">
      <label htmlFor={`${prefixo}-publico`}>{copy.publico}</label>
      <input id={`${prefixo}-publico`} type="text" value={rascunho.publico}
        onChange={evento => aoMudar({ publico: evento.target.value })} />
    </p>
    <p className="dz-empresa-campo">
      <label htmlFor={`${prefixo}-oferta`}>{copy.oferta}</label>
      <textarea id={`${prefixo}-oferta`} rows={2} value={rascunho.oferta}
        onChange={evento => aoMudar({ oferta: evento.target.value })} />
      <span className="dz-empresa-ajuda">{copy.ofertaAjuda}</span>
    </p>
    <p className="dz-empresa-campo">
      <label htmlFor={`${prefixo}-limites`}>{copy.limites}</label>
      <textarea id={`${prefixo}-limites`} rows={3} value={rascunho.limites}
        onChange={evento => aoMudar({ limites: evento.target.value })} />
      <span className="dz-empresa-ajuda">{copy.limitesAjuda}</span>
    </p>
  </>
}

/** O plano de uma versão, como a tela o lê. Exportado pela mesma razão. */
export function PlanoLido({ registro }: { readonly registro: RegistroDePlano }) {
  return <dl className="dz-empresa-plano">
    <div><dt>{copy.objetivo}</dt><dd>{registro.plano.objetivo}</dd></div>
    <div><dt>{copy.publico}</dt><dd>{registro.plano.publico}</dd></div>
    {registro.plano.oferta !== '' && <div><dt>{copy.oferta}</dt><dd>{registro.plano.oferta}</dd></div>}
    <div>
      <dt>{copy.limites}</dt>
      <dd>{registro.plano.limites.length === 0
        ? copy.semLimites
        : <ul>{registro.plano.limites.map(limite => <li key={limite}>{limite}</li>)}</ul>}</dd>
    </div>
  </dl>
}

/**
 * A tela das empresas — `BUS-01`, a porta do Modo Empresa.
 *
 * A ação NOVA que ela entrega, inteira: cadastrar uma empresa com objetivo,
 * público e limites, ver o plano gravado com a versão dele, gravar uma versão
 * nova sem apagar a anterior, e arquivar. Tudo persistido no servidor — não há
 * estado encenado nesta tela, e nenhum botão que não faz nada.
 *
 * O que ela NÃO faz, e o texto diz: não confere identidade jurídica contra
 * registro nenhum, e não apaga empresa. Arquivar tira das listas; apagar dado é
 * destrutivo e exige decisão explícita do dono.
 */
export function EmpresaScreen({ api = cliente }: { readonly api?: EmpresaApi } = {}) {
  const [empresas, setEmpresas] = useState<readonly Empresa[] | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [cadastrando, setCadastrando] = useState(false)
  const [rascunho, setRascunho] = useState<RascunhoDaEmpresa>(RASCUNHO_VAZIO)
  const [enviando, setEnviando] = useState(false)
  const [aviso, setAviso] = useState<string | null>(null)
  const [aberta, setAberta] = useState<{ readonly empresa: Empresa; readonly planos: readonly RegistroDePlano[] } | null>(null)
  const [revisao, setRevisao] = useState<RascunhoDoPlano | null>(null)
  const [tarefas, setTarefas] = useState<readonly VinculoDeTarefa[]>([])
  const [projetos, setProjetos] = useState<readonly { readonly project_id: string; readonly name: string }[]>([])
  const [novaTarefa, setNovaTarefa] = useState<RascunhoDaTarefa | null>(null)
  /*
    A chave de intenção vive num `ref`, e não no estado: ela precisa sobreviver
    ao render sem causar outro, e precisa ser a MESMA em cada tentativa do mesmo
    envio. Ela só é trocada quando um envio completa.
  */
  const chaveDoEnvio = useRef<string | null>(null)

  const ler = useCallback(async () => {
    try {
      setEmpresas(await api.empresas())
      setErro(null)
    } catch (causa) {
      // Três estados, e não dois: ainda lendo, leu e não há nenhuma, não deu
      // para ler. Colapsar o terceiro no segundo diria "você não tem empresa"
      // para quem tem.
      setErro(causa instanceof Error ? causa.message : copy.erroLeitura)
      setEmpresas([])
    }
  }, [api])

  useEffect(() => { void ler() }, [ler])

  const abrir = useCallback(async (businessId: string) => {
    try {
      const lida = await api.empresa(businessId)
      setAberta({ empresa: lida.business, planos: lida.plans })
      const [vinculos, lista] = await Promise.all([api.tarefas(businessId), api.projetos()])
      setTarefas(vinculos)
      setProjetos(lista)
      setRevisao(null)
      setNovaTarefa(null)
    } catch (causa) {
      setErro(causa instanceof Error ? causa.message : copy.erroLeitura)
    }
  }, [api])

  const recusaDoCadastro = recusaDaEmpresa(rascunho)

  async function cadastrar() {
    if (recusaDoCadastro !== null) return
    setEnviando(true)
    try {
      const identidade = textoNormalizado(rascunho.identidade)
      const criada = await api.criar({
        nome: textoNormalizado(rascunho.nome),
        origem: rascunho.origem,
        identidade_juridica_declarada: identidade === '' ? null : identidade,
        plano: planoDoRascunho(rascunho),
      })
      setRascunho(RASCUNHO_VAZIO)
      setCadastrando(false)
      setAviso(copy.criada)
      await ler()
      await abrir(criada.business.business_id)
    } catch (causa) {
      setErro(causa instanceof Error ? causa.message : copy.erroLeitura)
    } finally {
      setEnviando(false)
    }
  }

  const vigente = aberta === null ? undefined : versaoVigente(aberta.planos)
  const recusaDaVersao = revisao === null || vigente === undefined ? null : recusaDaRevisao(revisao, vigente.plano)

  async function gravarRevisao() {
    if (aberta === null || revisao === null || recusaDaVersao !== null) return
    setEnviando(true)
    try {
      await api.revisarPlano(aberta.empresa.business_id, planoDoRascunho(revisao))
      setRevisao(null)
      setAviso(copy.revisada)
      await abrir(aberta.empresa.business_id)
    } catch (causa) {
      setErro(causa instanceof Error ? causa.message : copy.erroLeitura)
    } finally {
      setEnviando(false)
    }
  }

  const recusaDoPedido = novaTarefa === null ? null : recusaDaTarefa(novaTarefa)

  async function criarTarefa() {
    if (aberta === null || novaTarefa === null || recusaDoPedido !== null) return
    setEnviando(true)
    try {
      /*
        A chave de intenção do envio.

        Ela atravessa inteira até o serviço de tarefas, que já sabe tratá-la: é
        a MESMA identidade da criação normal, e não uma segunda. Sem ela, quem
        aperta duas vezes — ou reenvia depois de perder a resposta — fica com
        duas tarefas para a mesma empresa.
      */
      const criada = await api.criarTarefa(aberta.empresa.business_id, {
        pedido: novaTarefa.pedido,
        category: novaTarefa.category,
        privacy: 'privado-local',
        request_key: chaveDoEnvio.current ?? (chaveDoEnvio.current = novaChaveDeEnvio()),
      })
      chaveDoEnvio.current = null
      setNovaTarefa(null)
      setAviso(copy.tarefaCriada)
      const [vinculos, lista] = await Promise.all([api.tarefas(aberta.empresa.business_id), api.projetos()])
      setTarefas(vinculos)
      setProjetos(lista)
      return criada
    } catch (causa) {
      setErro(causa instanceof Error ? causa.message : copy.erroLeitura)
      return undefined
    } finally {
      setEnviando(false)
    }
  }

  async function arquivar() {
    if (aberta === null) return
    setEnviando(true)
    try {
      await api.arquivar(aberta.empresa.business_id)
      setAviso(copy.arquivada)
      setAberta(null)
      await ler()
    } catch (causa) {
      setErro(causa instanceof Error ? causa.message : copy.erroLeitura)
    } finally {
      setEnviando(false)
    }
  }

  return <main className="dz-empresa">
    <header className="dz-destino-topo">
      <a className="dz-destino-voltar" href={STUDIO_HOME_PATH}><ArrowLeft aria-hidden="true" /><span>{copy.voltar}</span></a>
      <div><h1>{copy.titulo}</h1><p>{copy.subtitulo}</p></div>
    </header>

    {erro !== null && <p className="dz-empresa-erro" role="alert">{erro}</p>}
    {aviso !== null && <p className="dz-empresa-aviso" role="status">{aviso}</p>}

    {empresas === null
      ? <p className="dz-destino-vazio" role="status">{copy.lendo}</p>
      : <>
        {!cadastrando && <p className="dz-empresa-acoes">
          <button type="button" className="dz-empresa-primario" onClick={() => { setCadastrando(true); setAviso(null) }}>
            <Building2 aria-hidden="true" /><span>{copy.novaEmpresa}</span>
          </button>
        </p>}

        {cadastrando && <form className="dz-empresa-form" onSubmit={evento => { evento.preventDefault(); void cadastrar() }}>
          <h2>{copy.novaEmpresa}</h2>
          <p className="dz-empresa-campo">
            <label htmlFor="dz-empresa-nome">{copy.nome}</label>
            <input id="dz-empresa-nome" type="text" value={rascunho.nome}
              onChange={evento => setRascunho({ ...rascunho, nome: evento.target.value })} />
            <span className="dz-empresa-ajuda">{copy.nomeAjuda}</span>
          </p>
          <fieldset className="dz-empresa-origem">
            <legend>{copy.origem}</legend>
            {(['criada', 'vinculada'] as const).map(origem => <label key={origem}>
              <input type="radio" name="dz-empresa-origem" value={origem} checked={rascunho.origem === origem}
                onChange={() => setRascunho({ ...rascunho, origem })} />
              <span>{origem === 'criada' ? copy.origemCriada : copy.origemVinculada}</span>
            </label>)}
          </fieldset>
          <p className="dz-empresa-campo">
            <label htmlFor="dz-empresa-identidade">{copy.identidade}</label>
            <input id="dz-empresa-identidade" type="text" value={rascunho.identidade}
              onChange={evento => setRascunho({ ...rascunho, identidade: evento.target.value })} />
            <span className="dz-empresa-ajuda">{copy.identidadeAjuda}</span>
          </p>
          <CamposDoPlano rascunho={rascunho} prefixo="dz-empresa"
            aoMudar={parcial => setRascunho({ ...rascunho, ...parcial })} />
          {recusaDoCadastro !== null && <p className="dz-empresa-recusa" role="status">{frase(recusaDoCadastro)}</p>}
          <p className="dz-empresa-acoes">
            <button type="submit" className="dz-empresa-primario" disabled={recusaDoCadastro !== null || enviando}>
              {enviando ? copy.salvando : copy.salvar}
            </button>
            <button type="button" onClick={() => { setCadastrando(false); setRascunho(RASCUNHO_VAZIO) }}>{copy.cancelar}</button>
          </p>
        </form>}

        {empresas.length === 0 && !cadastrando && <div className="dz-empresa-vazio">
          <p>{copy.vazio}</p>
          <p className="dz-destino-vazio">{copy.vazioAjuda}</p>
        </div>}

        <ul className="dz-empresa-lista">
          {empresas.map(empresa => <li key={empresa.business_id} className="dz-empresa-item">
            <h2>{empresa.nome}</h2>
            {empresa.identidade_juridica_declarada !== null
              && <p className="dz-empresa-identidade">{empresa.identidade_juridica_declarada}</p>}
            <button type="button" className="dz-empresa-abrir"
              aria-expanded={aberta?.empresa.business_id === empresa.business_id}
              onClick={() => { if (aberta?.empresa.business_id === empresa.business_id) setAberta(null); else void abrir(empresa.business_id) }}>
              {copy.abrir}
            </button>
            {aberta?.empresa.business_id === empresa.business_id && vigente !== undefined && <div className="dz-empresa-detalhe">
              <h3>{copy.planoVersao.replace('{n}', String(vigente.version))}</h3>
              <PlanoLido registro={vigente} />
              {revisao === null
                ? <p className="dz-empresa-acoes">
                  <button type="button" onClick={() => setRevisao(rascunhoDoPlano(vigente.plano))}>{copy.revisarPlano}</button>
                </p>
                : <div className="dz-empresa-revisao">
                  <CamposDoPlano rascunho={revisao} prefixo="dz-empresa-revisao"
                    aoMudar={parcial => setRevisao({ ...revisao, ...parcial })} />
                  {recusaDaVersao !== null && <p className="dz-empresa-recusa" role="status">{frase(recusaDaVersao)}</p>}
                  <p className="dz-empresa-acoes">
                    <button type="button" className="dz-empresa-primario" disabled={recusaDaVersao !== null || enviando}
                      onClick={() => void gravarRevisao()}>{enviando ? copy.salvando : copy.revisarPlano}</button>
                    <button type="button" onClick={() => setRevisao(null)}>{copy.cancelar}</button>
                  </p>
                </div>}
              {versoesAnteriores(aberta.planos).length > 0 && <details className="dz-empresa-historico">
                <summary>{copy.planoHistorico}</summary>
                {versoesAnteriores(aberta.planos).map(registro => <section key={registro.plan_id}>
                  <h4>{copy.planoVersao.replace('{n}', String(registro.version))}</h4>
                  <PlanoLido registro={registro} />
                </section>)}
              </details>}
              <section className="dz-empresa-tarefas" aria-labelledby={`dz-empresa-tarefas-${empresa.business_id}`}>
                <h4 id={`dz-empresa-tarefas-${empresa.business_id}`}>{copy.tarefas}</h4>
                {tarefas.length === 0
                  ? <p className="dz-destino-vazio">{copy.tarefasVazio}</p>
                  : <ul className="dz-empresa-tarefas-lista">
                    {tarefas.map((vinculo, indice) => <li key={vinculo.link_id}>
                      {/*
                        O NOME da tarefa é o rótulo do link, e não a palavra
                        "Abrir": com três tarefas, três linhas iguais não dizem
                        qual é qual — nem para quem vê, nem para quem ouve.
                      */}
                      <a href={`${STUDIO_HOME_PATH}?projeto=${encodeURIComponent(vinculo.project_id)}`}>
                        {nomesDasTarefas(tarefas, projetos)[indice] ?? copy.tarefaSemNome}
                      </a>
                      {' '}
                      <span className="dz-empresa-ajuda">
                        {copy.tarefaVersao.replace('{n}', String(vinculo.plan_version))}
                      </span>
                    </li>)}
                  </ul>}
                {novaTarefa === null
                  ? <p className="dz-empresa-acoes">
                    <button type="button" onClick={() => setNovaTarefa(TAREFA_VAZIA)}>{copy.criarTarefa}</button>
                  </p>
                  : <div className="dz-empresa-nova-tarefa">
                    <p className="dz-empresa-campo">
                      <label htmlFor="dz-empresa-pedido">{copy.pedido}</label>
                      <textarea id="dz-empresa-pedido" rows={3} value={novaTarefa.pedido}
                        onChange={evento => setNovaTarefa({ ...novaTarefa, pedido: evento.target.value })} />
                      <span className="dz-empresa-ajuda">{copy.pedidoAjuda}</span>
                    </p>
                    <p className="dz-empresa-campo">
                      <label htmlFor="dz-empresa-tipo">{copy.tipo}</label>
                      <select id="dz-empresa-tipo" value={novaTarefa.category}
                        onChange={evento => setNovaTarefa({ ...novaTarefa, category: evento.target.value })}>
                        {STUDIO_CATEGORIES.map(categoria => <option key={categoria} value={categoria}>
                          {copyGeral.idea.kinds[categoria]}
                        </option>)}
                      </select>
                    </p>
                    {recusaDoPedido !== null && <p className="dz-empresa-recusa" role="status">{frase(recusaDoPedido)}</p>}
                    <p className="dz-empresa-acoes">
                      <button type="button" className="dz-empresa-primario" disabled={recusaDoPedido !== null || enviando}
                        onClick={() => void criarTarefa()}>{enviando ? copy.criando : copy.criarAgora}</button>
                      <button type="button" onClick={() => setNovaTarefa(null)}>{copy.cancelar}</button>
                    </p>
                  </div>}
              </section>
              <p className="dz-empresa-acoes">
                <button type="button" className="dz-empresa-arquivar" disabled={enviando}
                  onClick={() => void arquivar()}>{copy.arquivar}</button>
                <span className="dz-empresa-ajuda">{copy.arquivarAjuda}</span>
              </p>
            </div>}
          </li>)}
        </ul>
      </>}
  </main>
}
