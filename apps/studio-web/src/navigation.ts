import { ASSISTANT_PATH } from './assistant/AssistantEntry'
import { HUB_PATH } from './hub/presentation'
import { HELP_PATH } from './help/HelpScreen'
import { PROJECTS_PATH } from './projects/ProjectsScreen'
import { TEAM_PATH } from './team/teamApi'
import assistant from './i18n/assistant.pt-BR.json'
import hub from './i18n/hub.pt-BR.json'
import team from './i18n/team.pt-BR.json'
import t from './i18n/pt-BR.json'

/** Identificador do painel de navegação, usado por `aria-controls` no botão do menu. */
export const NAV_MENU_ID = 'studio-nav'

/** Caminho da tela inicial do Studio. */
export const STUDIO_HOME_PATH = '/studio/'

export type StudioNavItem = {
  readonly id: 'home' | 'assistant' | 'hub' | 'projects' | 'progress' | 'help'
  readonly label: string
  /**
   * O destino, SEMPRE real.
   *
   * Este campo já foi `string | null`, e o `null` desenhava um item
   * desabilitado com a etiqueta "em breve". A intenção era honesta — melhor
   * dizer que a tela não existe do que dar um botão que a pessoa aperta e nada
   * acontece —, mas o efeito era outro: o Prado leu a etiqueta e concluiu, com
   * razão, que o produto estava se anunciando como inacabado toda vez que
   * alguém abria o menu.
   *
   * Os dois últimos itens sem destino foram embora — "Meus projetos" ganhou
   * tela, "Ver resultado" não precisava de uma — e o tipo mudou junto, para
   * que a etiqueta não possa voltar por descuido: um item novo agora não
   * compila sem destino.
   */
  readonly href: string
}

/**
 * Os itens da navegação, na ordem em que aparecem.
 *
 * A lista é a mesma no computador e no celular de propósito: quando ela existia
 * só na barra lateral, abaixo de 820px o produto ficava sem navegação nenhuma e
 * a tela de confirmações só era alcançável digitando o endereço.
 * @returns os itens, todos com destino real.
 */
export function studioNavItems(): readonly StudioNavItem[] {
  return [
    { id: 'home', label: t.nav.home, href: STUDIO_HOME_PATH },
    { id: 'assistant', label: assistant.navLabel, href: ASSISTANT_PATH },
    { id: 'hub', label: hub.navLabel, href: HUB_PATH },
    // Este item ficou "em breve" desde o começo enquanto `GET /projects` já
    // respondia: faltava só a tela. Quem fechava o navegador no meio de uma
    // criação não tinha caminho de volta pela interface.
    { id: 'projects', label: t.nav.projects, href: PROJECTS_PATH },
    // O item se chama pelo que a TELA é: trabalho em equipe. Enquanto ele se
    // chamava "Progresso", a pessoa cujo aplicativo estava sendo criado clicava
    // ali esperando acompanhar a criação e caía em "Nenhum trabalho em equipe
    // foi iniciado neste projeto" — outra coisa. O progresso da criação vive na
    // própria tela inicial, sob "Seu projeto em andamento", que é onde ela já
    // está quando isso importa.
    { id: 'progress', label: team.navLabel, href: TEAM_PATH },
    // "Ver resultado" MORREU aqui, e isso é a correção, não uma perda.
    //
    // Ele era um item mudo marcado "em breve" desde o começo, e o Prado leu
    // isso exatamente como devia ser lido: um produto que anuncia o que ainda
    // não faz está dizendo que não está pronto. Só que a tela prometida nunca
    // ia existir: o resultado NÃO é um lugar separado. Ele é o pé da tela
    // inicial — a verificação, o relato, os pontos de retorno e a prévia
    // embutida —, e "Início" já leva ao projeto aberto, que fica guardado no
    // endereço. Um item de navegação que duplica outro não ajuda quem não
    // programa: dá uma segunda porta para a mesma sala e faz a pessoa se
    // perguntar qual das duas era a certa.
    //
    // Para voltar a OUTRO projeto existe "Meus projetos", que é o caminho real.
    // A ajuda também vive na LISTA, e não só como ícone no rodapé da barra: um
    // ícone sem rótulo é a última coisa que quem não programa procura quando
    // está com dúvida.
    { id: 'help', label: t.nav.help, href: HELP_PATH },
  ]
}

/**
 * Qual item corresponde ao endereço aberto.
 * @param pathname - o caminho atual do navegador.
 * @returns o id do item, ou `null` quando o endereço não é uma tela da lista.
 */
export function activeNavId(pathname: string): StudioNavItem['id'] | null {
  for (const item of studioNavItems()) {
    if (item.href !== STUDIO_HOME_PATH && pathname.startsWith(item.href)) return item.id
  }
  if (pathname === STUDIO_HOME_PATH || pathname === '/studio') return 'home'
  return null
}
