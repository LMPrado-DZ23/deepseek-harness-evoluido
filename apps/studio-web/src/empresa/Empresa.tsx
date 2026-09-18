import { ArrowLeft, Building2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import copy from '../i18n/empresa.pt-BR.json'
import { STUDIO_HOME_PATH } from '../navigation'
import { createEmpresaApi, type Empresa, type EmpresaApi, type RegistroDeOferta, type RegistroDePlano, type VinculoDeTarefa } from './empresaApi'
import {
  OFERTA_VAZIA, chaveDaMargem, chaveDoEstadoDaOferta, chaveDoRotuloDaMargem, dinheiroEmTexto, margemDaOferta,
  ofertaDoRascunho, percentualEmTexto, rascunhoDaOferta, recusaDaOferta, recusaDeAprovacaoNaTela,
  sugestaoDePreco, type RascunhoDaOferta,
} from './oferta'
import { STUDIO_CATEGORIES } from '../categories'
import { createHubApi, HUB_API_PREFIX } from '../hub/hubApi'
import { formatBytes, formatDate } from '../hub/presentation'
import copyGeral from '../i18n/pt-BR.json'
import {
  RASCUNHO_VAZIO,
  TAREFA_VAZIA,
  planoDoRascunho,
  rascunhoDoPlano,
  recusaDaEmpresa,
  recusaDaRevisao,
  chaveDoTotal,
  evidenciaDasTarefas,
  nomesDasTarefas,
  totalDePacotes,
  type PacoteDaTarefa,
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
/*
  O cliente do Hub, criado UMA VEZ — pela mesma razão que o de empresas: um
  objeto novo a cada render faria o efeito que depende dele disparar outra
  leitura, e foi assim que a Biblioteca chegou a 621 chamadas em 3 segundos.

  A evidência é LIDA de quem já a guarda. O Modo Empresa não grava uma cópia dos
  pacotes: o `integration-hub` já os tem, com recibo e resumo criptográfico, e
  uma segunda contabilidade de evidência divergiria justamente no ponto em que
  alguém a lê para decidir se o trabalho foi entregue.
*/
const clienteDoHub = createHubApi()

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

/**
 * Os pacotes das tarefas desta empresa, lidos de quem já os guarda.
 *
 * Uma leitura por tarefa, porque é assim que o Hub guarda. A leitura que falha
 * NÃO derruba a seção inteira e não apaga o que as outras tarefas produziram:
 * ela devolve nada, e a tela deixa de mostrar o que não conseguiu ler — em vez
 * de afirmar que aquela tarefa não produziu.
 * @param vinculos - as tarefas da empresa.
 * @returns os pacotes de todas elas.
 */
async function lerPacotes(vinculos: readonly VinculoDeTarefa[]): Promise<readonly PacoteDaTarefa[]> {
  return (await Promise.all(vinculos.map(async vinculo => {
    try { return await clienteDoHub.exports(vinculo.project_id) } catch { return [] }
  }))).flat()
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
 * O que UMA tarefa produziu — `BUS-03`.
 *
 * TRÊS estados, e não dois: ainda lendo, leu e não há nada, leu e tem coisas.
 * Colapsar o primeiro no segundo diria "esta tarefa não produziu nada" enquanto
 * a leitura ainda estava em voo — que é afirmar sem ter olhado.
 */
export function EvidenciaDaTarefaLida({ pacotes }: { readonly pacotes: readonly PacoteDaTarefa[] | null }) {
  if (pacotes === null) return <p className="dz-empresa-ajuda">{copy.evidenciaLendo}</p>
  if (pacotes.length === 0) return <p className="dz-empresa-ajuda">{copy.evidencia}: {copy.evidenciaVazia}</p>
  return <ul className="dz-empresa-evidencia">
    {pacotes.map(pacote => <li key={pacote.export_id}>
      <a href={`${HUB_API_PREFIX}/projects/${encodeURIComponent(pacote.project_id)}/exports/${encodeURIComponent(pacote.export_id)}/download`}>
        {copy.baixar.replace('{file}', pacote.file_name)}
      </a>
      {' '}
      <span className="dz-empresa-ajuda">{formatBytes(pacote.size_bytes)} · {formatDate(pacote.created_at)}</span>
    </li>)}
  </ul>
}

/** Quantos pacotes a empresa já produziu, em português de gente. */
export function TotalDePacotes({ total }: { readonly total: number }) {
  const chave = chaveDoTotal(total)
  // Zero não vira uma frase: cada tarefa já diz que não produziu nada, e uma
  // linha repetindo isso no rodapé seria ruído.
  if (chave === null) return null
  return <p className="dz-empresa-ajuda">{copy[chave].replace('{n}', String(total))}</p>
}

/**
 * A MARGEM de uma oferta, com o estado do que se sabe — `BUS-03`.
 *
 * Três respostas, e nenhuma delas é zero. A frase do estado vem junto do número
 * de propósito: um "70,0%" sozinho é lido como fato, e o aceite exige que
 * "margem estimada declara custos ausentes e não é lucro garantido".
 */
export function MargemDaOfertaLida({ oferta }: { readonly oferta: RegistroDeOferta['oferta'] }) {
  const margem = margemDaOferta(oferta)
  return <div className="dz-empresa-margem">
    <p>
      <strong>{copy[chaveDoRotuloDaMargem(margem)]}</strong>
      {margem.porUnidade !== null && margem.percentual !== null && <>
        {': '}
        {dinheiroEmTexto(margem.porUnidade, oferta.moeda)}
        {' · '}
        {percentualEmTexto(margem.percentual)}
      </>}
    </p>
    <p className="dz-empresa-ajuda">{copy[chaveDaMargem(margem)]}</p>
    {margem.custosSemValor.length > 0 && <p className="dz-empresa-ajuda">
      {copy.margemSemValor.replace('{custos}', margem.custosSemValor.join(', '))}
    </p>}
  </div>
}

/**
 * UMA versão do catálogo, como a tela a lê.
 *
 * O estado — rascunho ou aprovada — vem antes de tudo porque é ele que decide o
 * que as condições significam: "condições aprovadas" só existem na versão que
 * alguém aprovou.
 */
export function OfertaLida({ registro }: { readonly registro: RegistroDeOferta }) {
  const { oferta } = registro
  return <div className="dz-empresa-oferta">
    <p className="dz-empresa-oferta-topo">
      <strong>{oferta.nome}</strong>
      {' '}
      <span className="dz-empresa-ajuda">{copy.ofertaVersao.replace('{versao}', String(registro.version))}</span>
      {' '}
      <span className={registro.approved_at === null ? 'dz-empresa-rascunho' : 'dz-empresa-aprovada'}>
        {copy[chaveDoEstadoDaOferta(registro)]}
      </span>
    </p>
    <dl className="dz-empresa-plano">
      <div><dt>{copy.ofertaEntrega}</dt><dd>{oferta.entrega}</dd></div>
      <div><dt>{copy.ofertaPublico}</dt><dd>{oferta.publico}</dd></div>
      <div>
        <dt>{copy.ofertaPreco}</dt>
        {/* Preço ausente é DITO, e não desenhado como zero nem deixado em branco. */}
        <dd>{oferta.preco === null ? copy.ofertaSemPreco : dinheiroEmTexto(oferta.preco, oferta.moeda)}</dd>
      </div>
      <div>
        <dt>{copy.ofertaCapacidade}</dt>
        <dd>{oferta.capacidade.quantidade} / {copy[periodoEmTexto(oferta.capacidade.periodo)]}</dd>
      </div>
      <div>
        <dt>{copy.ofertaCondicoes}</dt>
        <dd>{oferta.condicoes.length === 0
          ? copy.semLimites
          : <ul>{oferta.condicoes.map(condicao => <li key={condicao}>{condicao}</li>)}</ul>}</dd>
      </div>
    </dl>
    <MargemDaOfertaLida oferta={oferta} />
  </div>
}

/**
 * A chave do texto de um período.
 *
 * Existe como função porque um `periodo === 'dia' ? … : …` dentro do JSX não é
 * exercitado por teste nenhum, e porque um período novo no domínio tem de
 * quebrar o tipo aqui em vez de aparecer como chave indefinida na tela.
 * @param periodo - o período da capacidade.
 * @returns a chave do catálogo.
 */
export function periodoEmTexto(periodo: 'dia' | 'semana' | 'mes'): 'ofertaPeriodoDia' | 'ofertaPeriodoSemana' | 'ofertaPeriodoMes' {
  if (periodo === 'dia') return 'ofertaPeriodoDia'
  return periodo === 'semana' ? 'ofertaPeriodoSemana' : 'ofertaPeriodoMes'
}

/**
 * O preço SUGERIDO, mostrado e nunca aplicado.
 *
 * O texto de ajuda diz, com todas as letras, que ele não foi aplicado. Um
 * número sozinho ao lado de um campo de preço é lido como preenchimento, e o
 * aceite é explícito: "preço sugerido não publicado automaticamente".
 */
export function SugestaoDePreco({ rascunho, margemDesejada, aoMudarMargem }: {
  readonly rascunho: RascunhoDaOferta
  readonly margemDesejada: string
  readonly aoMudarMargem: (valor: string) => void
}) {
  const desejada = Number(margemDesejada.replace(',', '.'))
  const sugerido = sugestaoDePreco(ofertaDoRascunho(rascunho), desejada)
  return <div className="dz-empresa-sugestao">
    <p className="dz-empresa-campo">
      <label htmlFor="dz-empresa-margem-desejada">{copy.sugestaoMargem}</label>
      <input id="dz-empresa-margem-desejada" type="text" inputMode="decimal" value={margemDesejada}
        onChange={evento => aoMudarMargem(evento.target.value)} />
    </p>
    <p>
      <strong>{copy.sugestao}</strong>
      {': '}
      {sugerido === null
        ? copy.sugestaoSemCusto
        : dinheiroEmTexto(sugerido, ofertaDoRascunho(rascunho).moeda)}
    </p>
    <p className="dz-empresa-ajuda">{copy.sugestaoAjuda}</p>
  </div>
}

/** Os campos de uma oferta em edição. */
export function CamposDaOferta({ rascunho, aoMudar }: {
  readonly rascunho: RascunhoDaOferta
  readonly aoMudar: (parcial: Partial<RascunhoDaOferta>) => void
}) {
  return <>
    <p className="dz-empresa-campo">
      <label htmlFor="dz-oferta-nome">{copy.ofertaNome}</label>
      <input id="dz-oferta-nome" type="text" value={rascunho.nome}
        onChange={evento => aoMudar({ nome: evento.target.value })} />
    </p>
    <p className="dz-empresa-campo">
      <label htmlFor="dz-oferta-entrega">{copy.ofertaEntrega}</label>
      <textarea id="dz-oferta-entrega" rows={3} value={rascunho.entrega}
        onChange={evento => aoMudar({ entrega: evento.target.value })} />
      <span className="dz-empresa-ajuda">{copy.ofertaEntregaAjuda}</span>
    </p>
    <p className="dz-empresa-campo">
      <label htmlFor="dz-oferta-publico">{copy.ofertaPublico}</label>
      <input id="dz-oferta-publico" type="text" value={rascunho.publico}
        onChange={evento => aoMudar({ publico: evento.target.value })} />
    </p>
    <p className="dz-empresa-campo">
      <label htmlFor="dz-oferta-preco">{copy.ofertaPreco}</label>
      <input id="dz-oferta-preco" type="text" inputMode="decimal" value={rascunho.preco}
        onChange={evento => aoMudar({ preco: evento.target.value })} />
      <span className="dz-empresa-ajuda">{copy.ofertaPrecoAjuda}</span>
    </p>
    <p className="dz-empresa-campo">
      <label htmlFor="dz-oferta-moeda">{copy.ofertaMoeda}</label>
      <input id="dz-oferta-moeda" type="text" maxLength={3} value={rascunho.moeda}
        onChange={evento => aoMudar({ moeda: evento.target.value })} />
      <span className="dz-empresa-ajuda">{copy.ofertaMoedaAjuda}</span>
    </p>
    <p className="dz-empresa-campo">
      <label htmlFor="dz-oferta-quantidade">{copy.ofertaCapacidade}</label>
      <input id="dz-oferta-quantidade" type="text" inputMode="numeric" value={rascunho.quantidade}
        onChange={evento => aoMudar({ quantidade: evento.target.value })} />
    </p>
    <p className="dz-empresa-campo">
      <label htmlFor="dz-oferta-periodo">{copy.ofertaPeriodo}</label>
      <select id="dz-oferta-periodo" value={rascunho.periodo}
        onChange={evento => aoMudar({ periodo: evento.target.value as RascunhoDaOferta['periodo'] })}>
        <option value="dia">{copy.ofertaPeriodoDia}</option>
        <option value="semana">{copy.ofertaPeriodoSemana}</option>
        <option value="mes">{copy.ofertaPeriodoMes}</option>
      </select>
    </p>
    <p className="dz-empresa-campo">
      <label htmlFor="dz-oferta-condicoes">{copy.ofertaCondicoes}</label>
      <textarea id="dz-oferta-condicoes" rows={3} value={rascunho.condicoes}
        onChange={evento => aoMudar({ condicoes: evento.target.value })} />
      <span className="dz-empresa-ajuda">{copy.ofertaCondicoesAjuda}</span>
    </p>
    <fieldset className="dz-empresa-custos">
      <legend>{copy.ofertaCustos}</legend>
      <p className="dz-empresa-ajuda">{copy.ofertaCustosAjuda}</p>
      {rascunho.custos.map((custo, indice) => <p key={indice} className="dz-empresa-custo">
        <label htmlFor={`dz-oferta-custo-nome-${indice}`} className="dz-empresa-oculto">{copy.ofertaCustoNome}</label>
        <input id={`dz-oferta-custo-nome-${indice}`} type="text" placeholder={copy.ofertaCustoNome} value={custo.nome}
          onChange={evento => aoMudar({
            custos: rascunho.custos.map((item, posicao) => (posicao === indice ? { ...item, nome: evento.target.value } : item)),
          })} />
        <label htmlFor={`dz-oferta-custo-valor-${indice}`} className="dz-empresa-oculto">{copy.ofertaCustoValor}</label>
        <input id={`dz-oferta-custo-valor-${indice}`} type="text" inputMode="decimal" placeholder={copy.ofertaCustoValor} value={custo.valor}
          onChange={evento => aoMudar({
            custos: rascunho.custos.map((item, posicao) => (posicao === indice ? { ...item, valor: evento.target.value } : item)),
          })} />
        <button type="button" aria-label={copy.ofertaCustoRemover}
          onClick={() => aoMudar({ custos: rascunho.custos.filter((_, posicao) => posicao !== indice) })}>×</button>
      </p>)}
      <p className="dz-empresa-acoes">
        <button type="button" onClick={() => aoMudar({ custos: [...rascunho.custos, { nome: '', valor: '' }] })}>
          {copy.ofertaCustoAdicionar}
        </button>
      </p>
    </fieldset>
  </>
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
  /* `null` é "ainda lendo", que é diferente de "não produziu nada". */
  const [pacotes, setPacotes] = useState<readonly PacoteDaTarefa[] | null>(null)
  const [novaTarefa, setNovaTarefa] = useState<RascunhoDaTarefa | null>(null)
  /* `null` é "ainda lendo", e é diferente de "esta empresa não tem oferta". */
  const [ofertas, setOfertas] = useState<readonly RegistroDeOferta[] | null>(null)
  /*
    A oferta em edição, e QUAL oferta ela revisa.

    `offerKey: null` é oferta NOVA. Guardar as duas coisas juntas evita o estado
    impossível de estar editando sem saber se é criação ou revisão — que é
    exatamente onde uma revisão viraria uma oferta duplicada no catálogo.
  */
  const [ofertaEmEdicao, setOfertaEmEdicao] = useState<{ readonly offerKey: string | null; readonly rascunho: RascunhoDaOferta } | null>(null)
  const [margemDesejada, setMargemDesejada] = useState('50')
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
      setPacotes(null)
      setPacotes(await lerPacotes(vinculos))
      setNovaTarefa(null)
      setOfertaEmEdicao(null)
      setOfertas(null)
      setOfertas(await api.ofertas(businessId))
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

  const recusaDoCatalogo = ofertaEmEdicao === null ? null : recusaDaOferta(ofertaEmEdicao.rascunho)

  async function gravarOferta() {
    if (aberta === null || ofertaEmEdicao === null || recusaDoCatalogo !== null) return
    setEnviando(true)
    try {
      const enviada = ofertaDoRascunho(ofertaEmEdicao.rascunho)
      // A MESMA rota; a diferença entre criar e revisar é a chave da oferta, e
      // ela vem do estado — nunca do nome digitado, que muda entre versões.
      if (ofertaEmEdicao.offerKey === null) {
        await api.criarOferta(aberta.empresa.business_id, enviada)
      } else {
        await api.revisarOferta(aberta.empresa.business_id, ofertaEmEdicao.offerKey, enviada)
      }
      setOfertaEmEdicao(null)
      await abrir(aberta.empresa.business_id)
    } catch (causa) {
      setErro(causa instanceof Error ? causa.message : copy.erroLeitura)
    } finally {
      setEnviando(false)
    }
  }

  async function aprovarOferta(offerVersionId: string) {
    if (aberta === null) return
    setEnviando(true)
    try {
      await api.aprovarOferta(aberta.empresa.business_id, offerVersionId)
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
      // A tarefa recém-criada entra na seção de evidência junto, e não só na
      // próxima vez que alguém abrir a empresa.
      setPacotes(await lerPacotes(vinculos))
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
              <section className="dz-empresa-catalogo" aria-labelledby={`dz-empresa-catalogo-${empresa.business_id}`}>
                <h4 id={`dz-empresa-catalogo-${empresa.business_id}`}>{copy.catalogo}</h4>
                <p className="dz-empresa-ajuda">{copy.catalogoAjuda}</p>
                {/*
                  TRÊS estados, e não dois: ainda lendo, leu e não há nenhuma,
                  leu e tem. Dizer "não tem oferta" enquanto a leitura está em
                  voo é afirmar sem ter olhado.
                */}
                {ofertas === null
                  ? <p className="dz-empresa-ajuda">{copy.catalogoLendo}</p>
                  : ofertas.length === 0
                    ? <p className="dz-destino-vazio">{copy.catalogoVazio}</p>
                    : <ul className="dz-empresa-ofertas">
                      {ofertas.map(registro => <li key={registro.offer_key}>
                        <OfertaLida registro={registro} />
                        <p className="dz-empresa-acoes">
                          <button type="button" disabled={enviando}
                            onClick={() => setOfertaEmEdicao({ offerKey: registro.offer_key, rascunho: rascunhoDaOferta(registro.oferta) })}>
                            {copy.revisarOferta}
                          </button>
                          {/*
                            O botão de aprovar só aparece onde aprovar é
                            possível, e o que impede está escrito ao lado — um
                            botão ligado que recusa depois ensina a pessoa a
                            desconfiar do produto.
                          */}
                          {registro.approved_at === null && recusaDeAprovacaoNaTela(registro.oferta) === null && <button
                            type="button" className="dz-empresa-primario" disabled={enviando}
                            onClick={() => void aprovarOferta(registro.offer_version_id)}>
                            {enviando ? copy.aprovando : copy.aprovarOferta}
                          </button>}
                        </p>
                        {registro.approved_at === null && recusaDeAprovacaoNaTela(registro.oferta) !== null && <p className="dz-empresa-recusa" role="status">
                          {frase(recusaDeAprovacaoNaTela(registro.oferta)!)}
                        </p>}
                      </li>)}
                    </ul>}
                {ofertaEmEdicao === null
                  ? <p className="dz-empresa-acoes">
                    <button type="button" onClick={() => setOfertaEmEdicao({ offerKey: null, rascunho: OFERTA_VAZIA })}>
                      {copy.novaOferta}
                    </button>
                    <span className="dz-empresa-ajuda">{copy.ofertaNaoPublica}</span>
                  </p>
                  : <div className="dz-empresa-nova-oferta">
                    <CamposDaOferta rascunho={ofertaEmEdicao.rascunho}
                      aoMudar={parcial => setOfertaEmEdicao({ ...ofertaEmEdicao, rascunho: { ...ofertaEmEdicao.rascunho, ...parcial } })} />
                    <SugestaoDePreco rascunho={ofertaEmEdicao.rascunho} margemDesejada={margemDesejada} aoMudarMargem={setMargemDesejada} />
                    {recusaDoCatalogo !== null && <p className="dz-empresa-recusa" role="status">{frase(recusaDoCatalogo)}</p>}
                    <p className="dz-empresa-acoes">
                      <button type="button" className="dz-empresa-primario" disabled={recusaDoCatalogo !== null || enviando}
                        onClick={() => void gravarOferta()}>{enviando ? copy.salvando : copy.salvar}</button>
                      <button type="button" onClick={() => setOfertaEmEdicao(null)}>{copy.cancelar}</button>
                    </p>
                  </div>}
              </section>
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
                      <EvidenciaDaTarefaLida pacotes={pacotes === null ? null : evidenciaDasTarefas([vinculo], pacotes)[0]!.pacotes} />
                    </li>)}
                  </ul>}
                {pacotes !== null && <TotalDePacotes total={totalDePacotes(evidenciaDasTarefas(tarefas, pacotes))} />}
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
