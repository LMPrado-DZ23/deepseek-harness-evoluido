import { useEffect, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import preferencias from '../i18n/preferencias.pt-BR.json'
import { iniciaisDaConta } from '../shell/tarefasDoTrilho'
import { podeOperar, secaoInicial, secoesDePreferencias, type ContextoDasPreferencias, type GrupoDePreferencias, type SecaoDePreferencias } from './preferencias'

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
  // As capacidades que existem são DESTINOS: o link leva ao lugar onde elas já
  // funcionam, em vez de uma segunda cópia da mesma tela dentro do modal.
  return <p className="dz-preferencias-controle">
    <a className="dz-preferencias-destino" href={secao.href}>{preferencias.verDestino}</a>
  </p>
}
