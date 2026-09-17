import { useEffect, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import preferencias from '../i18n/preferencias.pt-BR.json'
import { iniciaisDaConta } from '../shell/tarefasDoTrilho'
import { podeOperar, secaoInicial, secoesDePreferencias, type ContextoDasPreferencias, type GrupoDePreferencias, type SecaoDePreferencias } from './preferencias'
import { chaveDoVeredito, contagemEmTexto, custoEmTexto, linhasDeUso, totalDeUso, type LinhaDeUso, type UsoDoEspaco } from './uso'
import { atalhosDoStudio } from './atalhos'
import { api } from '../api'

/**
 * As Preferências, como a referência as mostra: um modal com a navegação à
 * esquerda e a seção aberta à direita (F04/F05).
 *
 * O que ela NÃO faz é a parte que importa: nenhuma seção indisponível desenha
 * controle. Onde não há o que operar, há a frase que diz o que falta — e isso
 * vem de `secoesDePreferencias`, que tem teste, e não de um `disabled` escrito
 * à mão aqui dentro.
 *
 * Fechar não perde nada: o modal é irmão da tela, e o rascunho do compositor
 * mora no estado do `App`. A decisão do proprietário pede exatamente isso —
 * "abrir/fechar sem perder rascunho ou tarefa".
 */
export function Preferencias({ contexto, aoFechar, conta, notificacao }: {
  readonly contexto: ContextoDasPreferencias
  readonly aoFechar: () => void
  /** O nome de quem está na sessão, para a seção Conta. */
  readonly conta?: string | null
  /** O controle real de notificação, montado por quem tem a porta do navegador. */
  readonly notificacao?: ReactNode
}) {
  const secoes = secoesDePreferencias(contexto)
  const [aberta, setAberta] = useState<string | null>(() => secaoInicial(secoes))
  const dialogo = useRef<HTMLDivElement | null>(null)

  /*
    Esc fecha, e o foco entra no modal.

    Sem o foco aqui dentro, quem navega por teclado continuava na tela de trás:
    o modal aparecia para quem vê e não existia para quem não vê.
  */
  useEffect(() => {
    dialogo.current?.focus()
    function aoTeclar(evento: KeyboardEvent) { if (evento.key === 'Escape') aoFechar() }
    window.addEventListener('keydown', aoTeclar)
    return () => { window.removeEventListener('keydown', aoTeclar) }
  }, [aoFechar])

  const grupos: readonly GrupoDePreferencias[] = ['configuracoes', 'capacidades', 'dados']
  const selecionada = secoes.find(secao => secao.id === aberta) ?? null

  return <div className="dz-preferencias-fundo" onClick={evento => { if (evento.target === evento.currentTarget) aoFechar() }}>
    <div className="dz-preferencias" role="dialog" aria-modal="true" aria-label={preferencias.titulo} tabIndex={-1} ref={dialogo}>
      <nav className="dz-preferencias-lista" aria-label={preferencias.navegacao}>
        {/*
          O CABEÇALHO DA CONTA, como F04 o mostra no alto da coluna. O que NÃO
          vem junto é o campo de busca da referência: não há serviço de busca, e
          um campo que não busca é o botão mudo que a decisão proíbe.
        */}
        <p className="dz-preferencias-conta-topo">
          <span className="dz-preferencias-avatar" aria-hidden="true">{iniciaisDaConta(conta ?? null) ?? preferencias.avatarSemNome}</span>
          <span>{conta === null || conta === undefined || conta.trim() === '' ? preferencias.contaSemNome : conta}</span>
        </p>
        {grupos.map(grupo => <div key={grupo} className="dz-preferencias-grupo">
          <p className="dz-preferencias-grupo-titulo">{preferencias.grupos[grupo]}</p>
          <ul>
            {secoes.filter(secao => secao.grupo === grupo).map(secao => <li key={secao.id}>
              <button type="button" className={secao.id === aberta ? 'dz-preferencias-item dz-preferencias-item-aberto' : 'dz-preferencias-item'}
                aria-current={secao.id === aberta ? 'true' : undefined}
                onClick={() => setAberta(secao.id)}>
                {preferencias.secoes[secao.id as keyof typeof preferencias.secoes]}
              </button>
            </li>)}
          </ul>
        </div>)}
      </nav>
      <section className="dz-preferencias-corpo">
        <header className="dz-preferencias-topo">
          <h2>{selecionada === null ? preferencias.titulo : preferencias.secoes[selecionada.id as keyof typeof preferencias.secoes]}</h2>
          <button type="button" className="dz-preferencias-fechar" aria-label={preferencias.fechar} onClick={aoFechar}>
            <X aria-hidden="true" />
          </button>
        </header>
        {selecionada === null ? null : <Conteudo secao={selecionada} conta={conta ?? null} notificacao={notificacao} />}
      </section>
    </div>
  </div>
}

/**
 * O consumo do espaço de trabalho.
 *
 * TRÊS estados, e não dois: ainda lendo, leu, e não deu para ler. Colapsar o
 * terceiro no segundo mostraria uma tabela vazia para quem tem consumo — que é
 * a mesma classe de erro que "ausência vira zero", uma camada acima.
 *
 * A LIMITAÇÃO fica escrita na própria tela: cota de assinatura e custo
 * informado pelo provedor não existem neste produto. Sem essa frase, alguém lê
 * "Uso e custos" e supõe que está vendo a fatura.
 */
export function UsoDoEspacoDeTrabalho({ ler = () => api<UsoDoEspaco>('/usage') }: {
  readonly ler?: () => Promise<UsoDoEspaco>
} = {}) {
  const [uso, setUso] = useState<UsoDoEspaco | null>(null)
  const [erro, setErro] = useState(false)

  useEffect(() => {
    let vivo = true
    void ler().then(
      valor => { if (vivo) setUso(valor) },
      () => { if (vivo) setErro(true) },
    )
    return () => { vivo = false }
    // `ler` entra na lista porque é ele que define a leitura; o valor padrão é
    // recriado a cada render, e por isso quem monta em produção não o passa.
  }, [ler])

  if (erro) return <p className="dz-preferencias-pendencia" role="status">{preferencias.usoErro}</p>
  if (uso === null) return <p className="dz-preferencias-controle" role="status">{preferencias.usoLendo}</p>
  if (!uso.measured) return <p className="dz-preferencias-pendencia">{preferencias.usoSemMedicao}</p>
  return <TabelaDeUso linhas={linhasDeUso(uso.routes ?? [])} veredito={uso.budget?.verdict} />
}

/**
 * Os atalhos de teclado que o produto TEM.
 *
 * A lista vem de `atalhosDoStudio`, e a tela não escreve nenhum à mão: um
 * atalho listado e não implementado é o botão mudo da decisão do proprietário
 * com outra forma. A LIMITAÇÃO também está escrita — não dá para trocar as
 * teclas —, porque uma lista sem essa frase parece um painel de configuração.
 */
export function ListaDeAtalhos() {
  return <div className="dz-preferencias-uso">
    <table className="dz-preferencias-uso-tabela">
      <thead>
        <tr>
          <th scope="col">{preferencias.atalhosTecla}</th>
          <th scope="col">{preferencias.atalhosAcao}</th>
          <th scope="col">{preferencias.atalhosOnde}</th>
        </tr>
      </thead>
      <tbody>
        {atalhosDoStudio().map(atalho => <tr key={atalho.id}>
          <th scope="row">
            {atalho.teclas.map((tecla, indice) => <span key={tecla}>
              {indice > 0 && ' + '}<kbd>{tecla}</kbd>
            </span>)}
          </th>
          <td>{preferencias.atalhosNomes[atalho.id as keyof typeof preferencias.atalhosNomes]}</td>
          <td>{preferencias.atalhosEscopo[atalho.escopo]}</td>
        </tr>)}
      </tbody>
    </table>
    <p className="dz-preferencias-uso-limite">{preferencias.atalhosLimitacao}</p>
  </div>
}

/** O consumo já lido, desenhado. Separado para ter teste sem rede. */
export function TabelaDeUso({ linhas, veredito }: {
  readonly linhas: readonly LinhaDeUso[]
  readonly veredito: string | undefined
}) {
  const total = totalDeUso(linhas)
  const chave = chaveDoVeredito(veredito, total.chamadas > 0)
  return <div className="dz-preferencias-uso">
    <p className="dz-preferencias-uso-veredito" role="status">{preferencias.usoVeredito[chave]}</p>
    {linhas.length > 0 && <table className="dz-preferencias-uso-tabela">
      <thead>
        <tr>
          <th scope="col">{preferencias.usoRota}</th>
          <th scope="col">{preferencias.usoChamadas}</th>
          <th scope="col">{preferencias.usoTokens}</th>
          <th scope="col">{preferencias.usoCusto}</th>
        </tr>
      </thead>
      <tbody>
        {linhas.map(linha => <tr key={linha.rota}>
          <th scope="row">{linha.rota}</th>
          <td>{contagemEmTexto(linha.chamadas)}</td>
          <td>{contagemEmTexto(linha.tokens)}</td>
          <td>
            {/* Custo desconhecido é dito em palavras. NUNCA "US$ 0,0000". */}
            {linha.custoUsd === null ? preferencias.usoCustoDesconhecido : custoEmTexto(linha.custoUsd)}
            {linha.naoPrecificadas > 0 && <span className="dz-preferencias-uso-aviso">
              {' '}{preferencias.usoSemPreco.replace('{n}', contagemEmTexto(linha.naoPrecificadas))}
            </span>}
          </td>
        </tr>)}
      </tbody>
    </table>}
    <p className="dz-preferencias-uso-total">
      {preferencias.usoTotal
        .replace('{custo}', custoEmTexto(total.custoMedidoUsd))
        .replace('{chamadas}', contagemEmTexto(total.chamadas))}
    </p>
    {total.naoPrecificadas > 0 && <p className="dz-preferencias-uso-aviso">
      {preferencias.usoNaoPrecificadas.replace('{n}', contagemEmTexto(total.naoPrecificadas))}
    </p>}
    <p className="dz-preferencias-uso-limite">{preferencias.usoLimitacao}</p>
  </div>
}

function Conteudo({ secao, conta, notificacao }: {
  readonly secao: SecaoDePreferencias
  readonly conta: string | null
  readonly notificacao?: ReactNode
}) {
  if (!podeOperar(secao)) {
    return <p className="dz-preferencias-pendencia">
      <strong>{preferencias.pendenciaRotulo}</strong>
      <span>{preferencias.pendencias[secao.pendencia as keyof typeof preferencias.pendencias]}</span>
    </p>
  }
  if (secao.id === 'conta') {
    return <dl className="dz-preferencias-conta">
      <dt>{preferencias.contaNome}</dt>
      <dd>{conta === null || conta.trim() === '' ? preferencias.contaSemNome : conta}</dd>
    </dl>
  }
  if (secao.id === 'notificacoes') return <div className="dz-preferencias-controle">{notificacao}</div>
  if (secao.id === 'uso') return <UsoDoEspacoDeTrabalho />
  if (secao.id === 'atalhos') return <ListaDeAtalhos />
  // As capacidades que existem são DESTINOS: o link leva ao lugar onde elas já
  // funcionam, em vez de uma segunda cópia da mesma tela dentro do modal.
  return <p className="dz-preferencias-controle">
    <a className="dz-preferencias-destino" href={secao.href}>{preferencias.verDestino}</a>
  </p>
}
