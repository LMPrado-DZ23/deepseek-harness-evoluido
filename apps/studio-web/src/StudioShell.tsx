import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Menu } from 'lucide-react'
import { StudioSidebar } from './Navigation'
import { NAV_MENU_ID, activeNavId } from './navigation'
import t from './i18n/pt-BR.json'

/**
 * A casca do Studio: barra de navegação, gaveta no celular e área de trabalho.
 *
 * Ela existe porque a navegação era da TELA INICIAL e de mais nenhuma. Quem
 * clicava em "Ajuda", "Trabalho em equipe", "Integrações" ou "Conversar com o
 * DZ23" caía numa página **sem barra lateral nenhuma** — sem saída, a não ser
 * um link específico no meio do conteúdo, quando havia. Num produto para quem
 * não programa, isso é um beco: a pessoa vê a navegação, usa a navegação, e a
 * navegação desaparece.
 *
 * O comportamento de celular é o mesmo da tela inicial, e por isso mora aqui e
 * não repetido em cada tela: gaveta que abre pelo botão, fecha no `Escape`,
 * fecha ao clicar fora, e devolve o foco ao botão que a abriu — porque perder o
 * foco depois de fechar um menu joga quem navega por teclado de volta ao topo
 * da página.
 */
export function StudioShell({ children }: { readonly children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)

  function closeMenu() { setMenuOpen(false); menuButton.current?.focus() }

  useEffect(() => {
    if (!menuOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMenuOpen(false); menuButton.current?.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [menuOpen])

  return <div className="shell">
    <StudioSidebar active={activeNavId(window.location.pathname)} open={menuOpen} onClose={closeMenu} />
    {menuOpen ? <div className="drawer-scrim" aria-hidden="true" onClick={closeMenu} /> : null}
    <section className="workspace">
      <header className="topbar">
        <button ref={menuButton} type="button" className="mobile-menu" aria-label={t.mobile.menu}
          aria-expanded={menuOpen} aria-controls={NAV_MENU_ID} onClick={() => setMenuOpen(!menuOpen)}>
          <Menu aria-hidden="true" />
        </button>
      </header>
      {children}
    </section>
  </div>
}
