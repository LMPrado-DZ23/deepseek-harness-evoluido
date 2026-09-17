/**
 * Os destinos da navegação do workspace, um a um, com o que cada um mostra.
 *
 * A versão anterior deste trilho tinha TRÊS linhas e uma justificativa escrita
 * para as ausências: Agendado e Biblioteca não entravam porque não existiam, e
 * Habilidades e Plugins eram uma linha só porque abriam a mesma tela. A decisão
 * de produto respondeu às duas coisas na mesma frase: "Ausência de função
 * significa implementar e manter a pendência; não remover o requisito para
 * chamar o visual de completo", e "Biblioteca não é um apelido para Projetos".
 *
 * Então os seis destinos existem, e cada um diz a verdade sobre si:
 *
 * - **Habilidades** e **Plugins** compartilham o serviço do Hub (que é o que a
 *   decisão permite: "podem compartilhar componentes e serviços") e mostram
 *   RECORTES diferentes dele. Uma habilidade é texto que entra no contexto de
 *   um agente; um plugin é uma conexão com um serviço de fora. São duas
 *   perguntas diferentes, e quem procura uma não quer a lista da outra.
 * - **Biblioteca** é o acervo de artefatos exportados das tarefas — arquivo,
 *   tamanho, resumo e data, com o vínculo para a tarefa que o produziu. Não é
 *   a lista de projetos com outro nome.
 * - **Agendado** NÃO tem serviço neste produto. Ele fica aqui, com o destino
 *   real, e a tela diz que a função não existe ainda em vez de fingir uma
 *   lista vazia. `DISPONIBILIDADE` registra isso onde um teste alcança, para a
 *   pendência não depender de alguém lembrar.
 */
import type { IntegrationKind } from '../hub/presentation'

export const HABILIDADES_PATH = '/studio/habilidades'
export const PLUGINS_PATH = '/studio/plugins'
export const BIBLIOTECA_PATH = '/studio/biblioteca'
export const AGENDADO_PATH = '/studio/agendado'

export type Destino = 'habilidades' | 'plugins' | 'biblioteca' | 'agendado'

/**
 * Se a capacidade por trás do destino EXISTE neste produto.
 *
 * `pendente` não é "em breve" e não é um rótulo de marketing: é a declaração de
 * que a tela abre, diz o que falta, e não conta como funcionalidade entregue.
 */
export type Disponibilidade = 'pronto' | 'pendente'

export const DISPONIBILIDADE: Readonly<Record<Destino, Disponibilidade>> = {
  habilidades: 'pronto',
  plugins: 'pronto',
  biblioteca: 'pronto',
  // Agendamento de tarefa não existe no servidor. Ver `EXTERNAL_BLOCKERS`/
  // `INTERNAL_BLOCKERS`: o destino fica, a capacidade continua devendo.
  agendado: 'pendente',
}

export const CAMINHOS: Readonly<Record<Destino, string>> = {
  habilidades: HABILIDADES_PATH,
  plugins: PLUGINS_PATH,
  biblioteca: BIBLIOTECA_PATH,
  agendado: AGENDADO_PATH,
}

/**
 * Que tipos de integração cada destino mostra.
 *
 * Os dois recortes são DISJUNTOS e juntos cobrem os quatro tipos. As duas
 * coisas importam: sobreposição faria a mesma integração aparecer nas duas
 * telas com ações diferentes, e falta faria um tipo registrado não aparecer em
 * lugar nenhum — instalado, ativo, e invisível.
 */
export const ESCOPO: Readonly<Record<'habilidades' | 'plugins', readonly IntegrationKind[]>> = {
  habilidades: ['skill'],
  plugins: ['mcp', 'webhook', 'smtp'],
}

/** Todos os tipos de integração que o Hub conhece. */
export const TODOS_OS_TIPOS: readonly IntegrationKind[] = ['smtp', 'mcp', 'skill', 'webhook']

/**
 * O destino de um endereço.
 *
 * Compara por prefixo para a tela de um item (`/studio/plugins/algum`) continuar
 * marcando Plugins como o destino aberto.
 * @param pathname - o caminho atual do navegador.
 * @returns o destino, ou `null` quando o endereço é de outra tela.
 */
export function destinoDoCaminho(pathname: string): Destino | null {
  for (const [destino, caminho] of Object.entries(CAMINHOS) as [Destino, string][]) {
    if (pathname === caminho || pathname.startsWith(`${caminho}/`)) return destino
  }
  return null
}

/**
 * Se uma integração pertence a este destino.
 * @param destino - Habilidades ou Plugins.
 * @param kind - o tipo da integração.
 * @returns `true` quando ela deve aparecer ali.
 */
export function pertenceAoDestino(destino: 'habilidades' | 'plugins', kind: string): boolean {
  return (ESCOPO[destino] as readonly string[]).includes(kind)
}
