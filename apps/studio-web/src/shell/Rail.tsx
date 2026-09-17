import { Blocks, Bot, Building2, CircleHelp, Clock, FolderOpen, FolderPlus, Library, ListChecks, MessageSquare, Plus, Settings, SquarePen, Target, X, Zap, type LucideIcon } from 'lucide-react'
import { RAIL_ID, railSecoes, type RailIcone } from './rail'
import { NOVA_TAREFA_HREF, iniciaisDaConta, type TarefaDoTrilho } from './tarefasDoTrilho'
import { PROJECTS_PATH } from '../projects/ProjectsScreen'
import { HELP_PATH } from '../help/HelpScreen'
import rail from '../i18n/rail.pt-BR.json'
import type { ReactNode } from 'react'

/**
 * O trilho de navegação do workspace aprovado.
 *
 * A marca no topo é a do PROPRIETÁRIO — `dz23-mark-48.png`, derivada do
 * original por corte da margem externa, sem remoção de fundo e sem
 * revetorização. Ao lado dela vai o wordmark em texto, como a referência mostra
 * e como a decisão de marca pede: "ícone compacto e wordmark DZ23 Studio,
 * evitando duplicações enormes".
 *
 * O `srcSet` existe porque a especificação manda testar a marca em 1× e 2×: num
 * monitor de alta densidade, um PNG de 48px desenhado a 48px fica borrado, e
 * borrado é o que "extração ruim" parece para quem olha.
 */
const ICONES: Readonly<Record<RailIcone, LucideIcon>> = {
  SquarePen, Bot, Zap, Blocks, FolderOpen, ListChecks, Target, CircleHelp, Clock, Library, Building2,
}

export function Rail({ ativo, aberto, aoFechar, tarefas, conta, acoesDaConta }: {
  readonly ativo: string | null
  readonly aberto: boolean
  readonly aoFechar: () => void
  /**
   * As tarefas recentes. `null` é "ainda não li", e é DIFERENTE de lista
   * vazia: afirmar "suas tarefas aparecem aqui" antes de ler é dizer que não
   * há nenhuma sem ter perguntado.
   */
  readonly tarefas?: readonly TarefaDoTrilho[] | null
  /** O nome de quem está na sessão, quando há sessão. */
  readonly conta?: string | null
  /** O que a conta oferece no rodapé — sair, avisos. Montado por quem sabe. */
  readonly acoesDaConta?: ReactNode
}) {
  const iniciais = iniciaisDaConta(conta)
  return <nav id={RAIL_ID} className={`dz-rail${aberto ? ' aberto' : ''}`} aria-label={rail.navegacao}>
    <div className="dz-rail-topo">
    <a className="dz-marca" href="/studio/">
      <img
        src="/studio/brand/dz23-mark-48.png"
        srcSet="/studio/brand/dz23-mark-48.png 1x, /studio/brand/dz23-mark-96.png 2x"
        width={36} height={36} alt="" aria-hidden="true"
      />
      <span>{rail.marca}</span>
    </a>
    {/*
      A gaveta tem um botão de FECHAR visível. Fechar só tocando fora deixa
      presa a pessoa para quem o toque fora não funciona — e essa lição já foi
      aprendida uma vez, na barra anterior.
    */}
    <button type="button" className="dz-rail-fechar" aria-label={rail.fechar} onClick={aoFechar}>
      <X aria-hidden="true" />
    </button>
    </div>

    {railSecoes().map(secao => <div key={secao.id} className="dz-rail-secao">
      {/*
        O cabeçalho da seção leva a AÇÃO dela, como na referência: "Projetos"
        tem o "+" que cria um, "Tarefas" leva à lista inteira. Um título solto
        obriga a pessoa a procurar em outro lugar o que está bem ali.
      */}
      {secao.titulo === null ? null : <div className="dz-rail-cabecalho">
        <h2>{secao.titulo}</h2>
        {secao.id === 'projetos'
          ? <a className="dz-rail-acao" href={NOVA_TAREFA_HREF} aria-label={rail.criarProjeto} onClick={aoFechar}><Plus aria-hidden="true" /></a>
          : null}
        {secao.id === 'tarefas'
          ? <a className="dz-rail-acao-texto" href={PROJECTS_PATH} onClick={aoFechar}>{rail.verTodas}</a>
          : null}
      </div>}
      <ul>
        {secao.itens.map(item => {
          const Icone = ICONES[item.icone]
          return <li key={item.id}>
            {/*
              `aria-current="page"` e NÃO só uma classe: a cor de fundo diz onde
              a pessoa está para quem enxerga, e quem usa leitor de tela fica
              sem essa informação se ela existir só no CSS.
            */}
            <a href={item.href} className={ativo === item.id ? 'ativo' : undefined}
              aria-current={ativo === item.id ? 'page' : undefined} onClick={aoFechar}>
              <Icone aria-hidden="true" />
              <span>{item.label}</span>
            </a>
          </li>
        })}
        {secao.id === 'projetos' ? <li>
          <a href={NOVA_TAREFA_HREF} onClick={aoFechar}>
            <FolderPlus aria-hidden="true" />
            <span>{rail.novoProjeto}</span>
          </a>
        </li> : null}
      </ul>
      {/*
        As TAREFAS RECENTES, que é o que a referência põe aqui. Elas são reais:
        vêm de `GET /projects`, o mesmo serviço que a lista inteira usa. Três
        estados, e não dois — ainda não li, li e não há nenhuma, e a lista.
        Dizer "suas tarefas aparecem aqui" antes de ler afirma uma ausência que
        ninguém conferiu.
      */}
      {secao.id !== 'tarefas' || tarefas === undefined ? null
        : tarefas === null ? null
          : tarefas.length === 0 ? <p className="dz-rail-vazio">{rail.tarefasVazio}</p>
            : <ul className="dz-rail-tarefas">
              {tarefas.map(item => <li key={item.id}>
                <a href={item.href} className={item.aberta ? 'ativo' : undefined}
                  aria-current={item.aberta ? 'page' : undefined} onClick={aoFechar}>
                  <MessageSquare aria-hidden="true" />
                  <span>{item.nome}</span>
                </a>
              </li>)}
            </ul>}
    </div>)}

    {/*
      A CONTA NO RODAPÉ, como na referência — e não um botão "Sair" no topo.
      O avatar mostra as iniciais de quem está na sessão; sem nome, um símbolo
      neutro, porque uma letra que não é de ninguém é pior que nenhuma.
    */}
    {conta === undefined ? null : <div className="dz-rail-conta">
      <span className="dz-rail-avatar" aria-hidden="true">{iniciais ?? <Settings />}</span>
      <span className="dz-rail-nome">{conta ?? rail.semNome}</span>
      <span className="dz-rail-conta-acoes">
        {/* A ajuda desceu para o rodapé, junto da conta: ela é suporte, e não
            um destino de trabalho ao lado de Habilidades e Biblioteca. */}
        <a className="dz-rail-icone" href={HELP_PATH} aria-label={rail.ajuda} onClick={aoFechar}><CircleHelp aria-hidden="true" /></a>
        {acoesDaConta}
      </span>
    </div>}
  </nav>
}
