import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Menu } from 'lucide-react'
import { Rail } from './Rail'
import { RAIL_ID, railAtivo } from './rail'
import { tarefasDoTrilho, type TarefaDoServidor, type TarefaDoTrilho } from './tarefasDoTrilho'
import { api } from '../api'
import { savedProjectOf } from '../App'
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
/**
 * O aviso de que a lista de tarefas mudou.
 *
 * Um evento do documento, e não um estado compartilhado: a casca e a tela da
 * tarefa não têm ancestral comum onde esse estado pudesse morar, e criar um
 * contexto só para isto acoplaria as duas por uma lista de navegação.
 */
export const TAREFAS_MUDARAM = 'dz23:tarefas-mudaram'

export function WorkspaceShell({ titulo, contexto, acoes, conta, acoesDaConta, children }: {
  /** O nome do lugar onde a pessoa está. */
  readonly titulo?: string
  /** O que qualifica esse lugar — o projeto aberto, por exemplo. */
  readonly contexto?: string
  readonly acoes?: ReactNode
  /** Quem está na sessão, para o rodapé do trilho. */
  readonly conta?: string | null
  readonly acoesDaConta?: ReactNode
  readonly children: ReactNode
}) {
  const [aberto, setAberto] = useState(false)
  const botao = useRef<HTMLButtonElement>(null)
  /*
    As TAREFAS RECENTES do trilho.

    `null` é "ainda não li" e é diferente de lista vazia — a lateral não pode
    afirmar que não há tarefa nenhuma antes de perguntar. A leitura é a mesma
    rota que a lista inteira usa; não há serviço novo por trás disto.
  */
  const [tarefas, setTarefas] = useState<readonly TarefaDoTrilho[] | null>(null)
  useEffect(() => {
    let ativo = true
    const ler = () => {
      void api<{ projects: readonly TarefaDoServidor[] }>('/projects')
        .then(lido => {
          if (!ativo) return
          setTarefas(tarefasDoTrilho(lido.projects, savedProjectOf(window.location.href), window.location.href))
        })
        // A falha fica em "ainda não li": inventar uma lista vazia diria que a
        // pessoa não tem tarefas quando o que houve foi uma leitura que falhou.
        .catch(() => {})
    }
    ler()
    /*
      A lateral RELÊ quando uma tarefa nasce.

      Criar uma tarefa não remonta a casca — o endereço muda por
      `replaceState`. Sem esta escuta, a lateral continuava dizendo "suas
      tarefas aparecem aqui" com a tarefa recém-criada aberta ao lado, que é
      uma afirmação falsa sobre o trabalho da pessoa.
    */
    window.addEventListener(TAREFAS_MUDARAM, ler)
    return () => { ativo = false; window.removeEventListener(TAREFAS_MUDARAM, ler) }
  }, [])

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
    <Rail ativo={railAtivo(window.location.pathname)} aberto={aberto} aoFechar={() => setAberto(false)}
      tarefas={tarefas} {...(conta === undefined ? {} : { conta })} {...(acoesDaConta === undefined ? {} : { acoesDaConta })} />
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
        {/*
          O CONTEXTO fica no alto à esquerda, como na referência: o produto e,
          quando há uma tarefa aberta, o nome dela. A barra ficava vazia nas
          telas sem título, e uma faixa vazia atravessando o topo é espaço que
          não diz nada.
        */}
        <p className="dz-topbar-titulo">
          <span className="dz-topbar-produto">{rail.marca}</span>
          {titulo === undefined ? null : <><span className="dz-topbar-sep">·</span><span className="dz-topbar-tarefa">{titulo}</span></>}
          {contexto === undefined ? null : <span className="dz-topbar-sep">· {contexto}</span>}
        </p>
        {acoes === undefined ? null : <div className="dz-topbar-acoes">{acoes}</div>}
      </header>
      {children}
    </section>
  </div>
}
