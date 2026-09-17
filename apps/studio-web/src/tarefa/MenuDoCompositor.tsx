import { useEffect, useId, useRef, useState } from 'react'
import { Puzzle, Wrench } from 'lucide-react'
import tarefa from '../i18n/tarefa.pt-BR.json'
import { alemDoMenu, destinoDoMenu, itensDoMenu, ligadasNoMenu, type IntegracaoDoMenu, type MenuDoCompositor as Qual } from './menusDoCompositor'

/**
 * O menu ancorado no compositor (F08/F09), com o que ESTE Studio tem ligado.
 *
 * O botão mostra o número de ligadas — e quando não há nenhuma, ele diz isso
 * ao abrir, em vez de listar serviços que ninguém conectou. A referência mostra
 * os ícones das contas dela; copiá-los seria dado encenado.
 *
 * A ordem, o corte e a contagem moram em `menusDoCompositor.ts`, com teste.
 * Aqui fica só o desenho e o teclado.
 */
export function MenuDoCompositor({ qual, integracoes }: {
  readonly qual: Qual
  /** O que o Hub devolveu. `null` é "ainda não li", diferente de lista vazia. */
  readonly integracoes: readonly IntegracaoDoMenu[] | null
}) {
  const [aberto, setAberto] = useState(false)
  const caixa = useRef<HTMLDivElement | null>(null)
  const id = useId()

  useEffect(() => {
    if (!aberto) return undefined
    function aoTeclar(evento: KeyboardEvent) { if (evento.key === 'Escape') setAberto(false) }
    function aoClicar(evento: MouseEvent) {
      if (caixa.current !== null && !caixa.current.contains(evento.target as Node)) setAberto(false)
    }
    window.addEventListener('keydown', aoTeclar)
    window.addEventListener('mousedown', aoClicar)
    return () => { window.removeEventListener('keydown', aoTeclar); window.removeEventListener('mousedown', aoClicar) }
  }, [aberto])

  const lista = integracoes ?? []
  const itens = itensDoMenu(lista, qual)
  const ligadas = ligadasNoMenu(lista, qual)
  const restantes = alemDoMenu(lista, qual)
  const rotulo = qual === 'habilidades' ? tarefa.menuHabilidades : tarefa.menuPlugins

  return <div className="dz-menu-compositor" ref={caixa}>
    <button type="button" className="dz-menu-botao" aria-expanded={aberto} aria-controls={id}
      aria-label={rotulo} onClick={() => setAberto(valor => !valor)}>
      {qual === 'habilidades' ? <Wrench aria-hidden="true" /> : <Puzzle aria-hidden="true" />}
      {/*
        O número é quantas estão LIGADAS. Enquanto a leitura não voltou, não há
        número nenhum: escrever "0" antes de perguntar seria afirmar que não há
        nenhuma sem ter olhado.
      */}
      {integracoes === null ? null : <span className="dz-menu-conta">{ligadas}</span>}
    </button>
    {aberto
      ? <div className="dz-menu-caixa" id={id} role="group" aria-label={rotulo}>
        {integracoes === null
          ? <p className="dz-menu-vazio">{tarefa.menuLendo}</p>
          : itens.length === 0
            ? <p className="dz-menu-vazio">{qual === 'habilidades' ? tarefa.menuSemHabilidade : tarefa.menuSemPlugin}</p>
            : <ul className="dz-menu-itens">
              {itens.map(item => <li key={item.id}>
                <span className="dz-menu-nome">{item.nome}</span>
                <span className={item.ligada ? 'dz-menu-estado dz-menu-ligada' : 'dz-menu-estado'}>
                  {item.ligada ? tarefa.menuLigada : tarefa.menuDesligada}
                </span>
              </li>)}
            </ul>}
        {restantes > 0 ? <p className="dz-menu-restantes">{tarefa.menuRestantes.replace('{quantas}', String(restantes))}</p> : null}
        {/* Administrar é no destino, e não numa segunda cópia da tela aqui dentro. */}
        <a className="dz-menu-gerenciar" href={destinoDoMenu(qual)}>{tarefa.menuGerenciar}</a>
      </div>
      : null}
  </div>
}
