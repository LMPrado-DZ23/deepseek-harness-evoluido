import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Menu } from 'lucide-react'
import { Rail } from './Rail'
import { RAIL_ID, railAtivo } from './rail'
import rail from '../i18n/rail.pt-BR.json'

/**
 * A casca do workspace aprovado.
 *
 * Substitui a `StudioShell` anterior, que era a mesma ideia com outra
 * composição: trilho fixo à esquerda e gaveta no celular. O que muda é a
 * ESTRUTURA pedida pela decisão do Prado — trilho com seções, cabeçalho com o
 * contexto da tarefa, área de trabalho ampla — e não só a cor.
 *
 * O comportamento de gaveta é herdado inteiro, porque ele estava certo e é
 * caro de reaprender: abre pelo botão, fecha no `Escape`, fecha ao tocar fora,
 * e devolve o foco ao botão que a abriu. Perder o foco ao fechar joga quem
 * navega por teclado de volta ao topo da página.
 */
export function WorkspaceShell({ titulo, contexto, acoes, children }: {
  /** O nome do lugar onde a pessoa está. */
  readonly titulo?: string
  /** O que qualifica esse lugar — o projeto aberto, por exemplo. */
  readonly contexto?: string
  readonly acoes?: ReactNode
  readonly children: ReactNode
}) {
  const [aberto, setAberto] = useState(false)
  const botao = useRef<HTMLButtonElement>(null)

  function fechar() { setAberto(false); botao.current?.focus() }

  useEffect(() => {
    if (!aberto) return
    const aoTeclar = (evento: KeyboardEvent) => {
      if (evento.key === 'Escape') { setAberto(false); botao.current?.focus() }
    }
    window.addEventListener('keydown', aoTeclar)
    // A trava de rolagem vem junto: sem ela, arrastar sobre o escurecido rola a
    // página atrás da gaveta, e quem fecha volta num lugar que não é o seu.
    document.body.classList.add('menu-open')
    return () => { window.removeEventListener('keydown', aoTeclar); document.body.classList.remove('menu-open') }
  }, [aberto])

  return <div className="dz-shell">
    <Rail ativo={railAtivo(window.location.pathname)} aberto={aberto} aoFechar={() => setAberto(false)} />
    {aberto ? <div className="dz-scrim" aria-hidden="true" onClick={fechar} /> : null}
    <section className="dz-workspace">
      {/*
        `role="banner"` explícito, e não só a etiqueta `header`: dentro de uma
        `section` sem nome, `<header>` não é marco nenhum, e o axe reprovou
        exatamente isso — o título e os botões do topo ficavam fora de qualquer
        região, invisíveis para quem navega por marcos no leitor de tela.
      */}
      <header className="dz-topbar" role="banner">
        <button ref={botao} type="button" className="dz-menu" aria-label={rail.abrirMenu}
          aria-expanded={aberto} aria-controls={RAIL_ID} onClick={() => setAberto(!aberto)}>
          <Menu aria-hidden="true" />
        </button>
        {titulo === undefined ? null : <p className="dz-topbar-titulo">
          {titulo}
          {contexto === undefined ? null : <span>· {contexto}</span>}
        </p>}
        {acoes === undefined ? null : <div className="dz-topbar-acoes">{acoes}</div>}
      </header>
      {children}
    </section>
  </div>
}
