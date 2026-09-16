import { Blocks, Bot, CircleHelp, FolderOpen, ListChecks, SquarePen, Target, X, Zap, type LucideIcon } from 'lucide-react'
import { RAIL_ID, railSecoes, type RailIcone } from './rail'
import rail from '../i18n/rail.pt-BR.json'

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
  SquarePen, Bot, Zap, Blocks, FolderOpen, ListChecks, Target, CircleHelp,
}

export function Rail({ ativo, aberto, aoFechar }: {
  readonly ativo: string | null
  readonly aberto: boolean
  readonly aoFechar: () => void
}) {
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
      {secao.titulo === null ? null : <h2>{secao.titulo}</h2>}
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
      </ul>
    </div>)}
  </nav>
}
