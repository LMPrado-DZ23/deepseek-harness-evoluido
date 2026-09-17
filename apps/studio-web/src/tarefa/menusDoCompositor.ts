import type { IntegrationKind } from '../hub/presentation'
import { ESCOPO, HABILIDADES_PATH, PLUGINS_PATH } from '../destinos/destinos'

/**
 * Os MENUS ancorados no compositor (F08 e F09 da referência).
 *
 * Na referência, o compositor tem os ícones dos provedores e um menu que lista
 * o que está ligado, com "Conectar" ao lado do que não está. Aqui os ícones
 * daquelas contas não existem — e desenhar ícones de serviços que este
 * Studio não conectou seria dado encenado, que a decisão do proprietário
 * proíbe.
 *
 * O que existe é REAL: as integrações registradas no Hub, com o estado
 * verdadeiro de cada uma. O menu mostra essas, e quando não há nenhuma ele diz
 * isso — em vez de mostrar uma lista de exemplo.
 *
 * Função pura porque a regra que quebra primeiro é o CORTE e a ORDEM: quantas
 * cabem, quem vem antes, e o que aparece quando a lista está vazia. Decisão
 * dentro de um JSX não é exercitada por teste nenhum.
 */

/** Uma integração, no que interessa ao menu. */
export interface IntegracaoDoMenu {
  readonly integration_id: string
  readonly name: string
  readonly kind: string
  readonly enabled: boolean
}

export interface ItemDoMenu {
  readonly id: string
  readonly nome: string
  readonly kind: string
  /** Se ela está ligada AGORA. Nunca suposto: vem do servidor. */
  readonly ligada: boolean
}

/** Quantas cabem antes de o menu virar a tela inteira. */
export const ITENS_NO_MENU = 6

/** Os dois menus que o compositor ancora, cada um com o escopo do seu destino. */
export type MenuDoCompositor = 'habilidades' | 'plugins'

const DESTINO: Readonly<Record<MenuDoCompositor, string>> = {
  habilidades: HABILIDADES_PATH,
  plugins: PLUGINS_PATH,
}

/**
 * O endereço onde este menu é administrado por inteiro.
 * @param menu - qual dos dois.
 * @returns o caminho do destino.
 */
export function destinoDoMenu(menu: MenuDoCompositor): string {
  return DESTINO[menu]
}

/**
 * Os tipos que pertencem a este menu.
 *
 * Vem de `ESCOPO`, que já é a autoridade dos destinos: repetir a lista aqui
 * faria os dois discordarem no primeiro tipo novo — a segunda verdade que este
 * repositório já pagou caro.
 * @param menu - qual dos dois.
 * @returns os tipos de integração.
 */
export function tiposDoMenu(menu: MenuDoCompositor): readonly IntegrationKind[] {
  return ESCOPO[menu]
}

/**
 * Os itens deste menu, ligados primeiro.
 *
 * Ligada primeiro porque é o que a pessoa procura: o que está valendo AGORA
 * naquele envio. Dentro de cada grupo, a ordem é a do nome, para a lista não
 * mudar de posição a cada leitura.
 * @param integracoes - o que o Hub devolveu.
 * @param menu - qual dos dois menus.
 * @returns os itens a desenhar, já cortados.
 */
export function itensDoMenu(
  integracoes: readonly IntegracaoDoMenu[],
  menu: MenuDoCompositor,
): readonly ItemDoMenu[] {
  const tipos = new Set<string>(tiposDoMenu(menu))
  return integracoes
    .filter(integracao => tipos.has(integracao.kind))
    .map(integracao => ({
      id: integracao.integration_id,
      nome: integracao.name,
      kind: integracao.kind,
      ligada: integracao.enabled,
    }))
    .sort((esquerda, direita) => {
      if (esquerda.ligada !== direita.ligada) return esquerda.ligada ? -1 : 1
      return esquerda.nome.localeCompare(direita.nome, 'pt-BR')
    })
    .slice(0, ITENS_NO_MENU)
}

/**
 * Quantas estão LIGADAS neste menu — o número que o compositor mostra.
 *
 * Conta sobre a lista inteira, e não sobre os itens cortados: o menu mostra
 * seis, mas o número ao lado do botão é quantas valem no envio. Contar os
 * cortados diria "2" para quem tem oito ligadas.
 * @param integracoes - o que o Hub devolveu.
 * @param menu - qual dos dois menus.
 * @returns o número de ligadas.
 */
export function ligadasNoMenu(integracoes: readonly IntegracaoDoMenu[], menu: MenuDoCompositor): number {
  const tipos = new Set<string>(tiposDoMenu(menu))
  return integracoes.filter(integracao => tipos.has(integracao.kind) && integracao.enabled).length
}

/**
 * Se há mais do que cabe no menu.
 * @param integracoes - o que o Hub devolveu.
 * @param menu - qual dos dois menus.
 * @returns quantas ficaram de fora, ou zero.
 */
export function alemDoMenu(integracoes: readonly IntegracaoDoMenu[], menu: MenuDoCompositor): number {
  const tipos = new Set<string>(tiposDoMenu(menu))
  const total = integracoes.filter(integracao => tipos.has(integracao.kind)).length
  return Math.max(0, total - ITENS_NO_MENU)
}
