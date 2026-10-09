import { csrfToken } from '../api'

/**
 * As CONEXÕES DE IA do espaço de trabalho, como a tela as mostra.
 *
 * A lista vem de `/api/studio/routes/health` na ordem em que o serviço escolhe:
 * a primeira LIGADA e pronta é a que as criações usam. Desligar a IA local faz
 * a seguinte assumir — por exemplo, o Claude Code pela linha de comando.
 */
export interface RegistroDeRota {
  readonly route: string
  readonly state: string
  readonly enabled?: boolean
}

export interface RespostaDasRotas {
  readonly routes: readonly RegistroDeRota[]
  readonly names?: Readonly<Record<string, string>>
}

export type TipoDeConexao = 'local' | 'linha' | 'chave'
export type EstadoDeConexao = 'pronta' | 'naoConfigurada' | 'comFalha'

export interface LinhaDeConexao {
  readonly rota: string
  readonly nome: string
  readonly tipo: TipoDeConexao
  readonly estado: EstadoDeConexao
  readonly ligada: boolean
  /** Se é esta que as criações usam agora. */
  readonly emUso: boolean
}

/**
 * O tipo de uma conexão pela rota.
 * @param rota - a rota.
 * @returns local, linha de comando ou chave de API.
 */
export function tipoDaRota(rota: string): TipoDeConexao {
  if (rota === 'ollama') return 'local'
  return rota.startsWith('cli-') ? 'linha' : 'chave'
}

/**
 * As linhas da tela, na ordem do serviço.
 *
 * `emUso` marca a primeira ligada e pronta — a mesma regra de
 * `rotasDoServico` no servidor, para o perfil que usa a melhor disponível. Um
 * projeto no perfil privado continua preso à IA local, e a tela diz isso.
 * @param resposta - o que o servidor devolveu.
 * @returns as linhas.
 */
export function linhasDeConexao(resposta: RespostaDasRotas): readonly LinhaDeConexao[] {
  const vistas = new Set<string>()
  const unicas = resposta.routes.filter(registro => !vistas.has(registro.route) && vistas.add(registro.route) !== undefined)
  const emUso = unicas.find(registro => registro.enabled !== false && registro.state === 'OK')?.route
  return unicas.map(registro => ({
    rota: registro.route,
    nome: resposta.names?.[registro.route] ?? registro.route,
    tipo: tipoDaRota(registro.route),
    estado: registro.state === 'NOT_CONFIGURED' ? 'naoConfigurada' : registro.state === 'OK' ? 'pronta' : 'comFalha',
    ligada: registro.enabled !== false,
    emUso: registro.route === emUso,
  }))
}

/**
 * A resposta com UMA conexão já no estado pedido, antes de o servidor
 * confirmar.
 *
 * O interruptor responde na hora ao clique — um controle que não muda quando
 * a pessoa o aperta parece quebrado. Se o servidor recusar, a tela volta para
 * a resposta anterior e diz que a mudança não valeu.
 * @param resposta - o que o servidor confirmou por último.
 * @param rota - a conexão.
 * @param ligada - o estado pedido.
 * @returns a resposta prevista.
 */
export function comMudanca(resposta: RespostaDasRotas, rota: string, ligada: boolean): RespostaDasRotas {
  return { ...resposta, routes: resposta.routes.map(registro => registro.route === rota ? { ...registro, enabled: ligada } : registro) }
}

/** Lê as conexões. */
export async function lerConexoes(buscar: typeof fetch = fetch): Promise<RespostaDasRotas> {
  const resposta = await buscar('/api/studio/routes/health', { credentials: 'same-origin' })
  if (!resposta.ok) throw new Error(String(resposta.status))
  return await resposta.json() as RespostaDasRotas
}

/**
 * Liga ou desliga uma conexão.
 * @param rota - a rota.
 * @param ligada - o estado pedido.
 * @param buscar - o `fetch`.
 * @param token - o token CSRF.
 * @returns a lista depois da mudança.
 */
export async function mudarConexao(rota: string, ligada: boolean, buscar: typeof fetch = fetch, token: () => Promise<string> = csrfToken): Promise<RespostaDasRotas> {
  const resposta = await buscar('/api/studio/routes/enabled', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-dz23-csrf': await token() },
    body: JSON.stringify({ route: rota, enabled: ligada }),
  })
  if (!resposta.ok) throw new Error(String(resposta.status))
  return await resposta.json() as RespostaDasRotas
}
