/**
 * Por onde uma pesquisa SAI para a rede — e por que hoje ela não sai.
 *
 * `research.ts` resolveu a metade difícil: uma nota só entra se o trecho
 * LITERAL estiver no conteúdo da fonte, com impressão e validade. O que faltava
 * era a BUSCA: nada vai à rede, e por onde ela sairia é decisão com auditoria,
 * porque uma saída nova é superfície nova.
 *
 * O que estava parado era a AUTORIZAÇÃO, não o mecanismo. Este módulo é o
 * mecanismo, escrito para o estado de hoje: **nenhuma saída autorizada**.
 *
 * A regra é a mesma do endereço de integração (`policy/src/host.ts`),
 * e por uma razão que já custou caro lá: a decisão não mora numa lista de
 * expressões regulares comparada com o texto, porque o texto de um endereço não
 * é único. Aqui a política é ainda mais apertada, e de propósito — a integração
 * fala com quem o publicador assinou, e a pesquisa falaria com a internet.
 *
 * Três decisões:
 *
 * 1. **Lista vazia RECUSA tudo.** Não é "sem restrição": é "ninguém autorizou".
 *    Um campo não preenchido não pode virar permissão de sair para qualquer
 *    lugar — é a mesma escolha de `SEM_TABELA` no teto de dinheiro.
 * 2. **Só `https:`.** `http:` entrega o conteúdo a quem estiver no caminho, e a
 *    procedência de `research.ts` afirma que o trecho veio DAQUELA fonte. Sem
 *    transporte autenticado, a impressão prova que alguém entregou aqueles
 *    bytes, e não que a fonte os escreveu.
 * 3. **Sem redirecionamento seguido às cegas.** Cada salto é um endereço novo,
 *    e um endereço novo tem de passar pela mesma porta. `saltoPermitido` existe
 *    para que quem implementar a busca não possa "só seguir o Location".
 */
import { hostBloqueado, hostCanonico } from '@dz23-studio/policy'

/** Por que uma saída foi recusada. Nenhum destes colapsa em outro. */
export const RECUSAS_DE_SAIDA = [
  'SEM_AUTORIZACAO',
  'ESQUEMA_RECUSADO',
  'HOST_INTERNO',
  'FORA_DA_LISTA',
  'CREDENCIAL_NO_ENDERECO',
  'SALTOS_DEMAIS',
] as const
export type RecusaDeSaida = (typeof RECUSAS_DE_SAIDA)[number]

/** Quantos redirecionamentos uma busca pode seguir, cada um reconferido. */
export const MAX_SALTOS = 3

export interface PoliticaDeSaida {
  /** Os domínios autorizados. VAZIA por padrão, e vazia RECUSA. */
  readonly dominios: readonly string[]
}

/** A política em vigor hoje: nenhuma saída autorizada. */
export const SEM_SAIDA_AUTORIZADA: PoliticaDeSaida = { dominios: [] }

export type VeredictoDeSaida =
  | { readonly kind: 'PERMITIDO'; readonly host: string }
  | { readonly kind: 'RECUSADO'; readonly motivo: RecusaDeSaida; readonly detalhe: string }

/**
 * Se um domínio autorizado cobre este host.
 *
 * Cobre o domínio EXATO e os subdomínios dele, e nada mais. `example.com` não
 * cobre `notexample.com` — a comparação é por RÓTULO e não por sufixo de texto,
 * que é o erro clássico dessa verificação.
 * @param host - o host canônico.
 * @param dominio - a entrada da lista.
 * @returns `true` quando a entrada cobre o host.
 */
export function dominioCobre(host: string, dominio: string): boolean {
  const alvo = dominio.toLowerCase()
  if (alvo === '') return false
  return host === alvo || host.endsWith(`.${alvo}`)
}

/**
 * Se esta busca pode sair para este endereço.
 *
 * A ordem das recusas importa: `SEM_AUTORIZACAO` vem primeiro porque é a
 * resposta honesta hoje, e porque dizer "fora da lista" quando não existe lista
 * manda alguém acrescentar um domínio a uma lista que ninguém ligou.
 * @param endereco - o endereço que a busca quer ler.
 * @param politica - a política em vigor.
 * @returns o veredito.
 */
export function saidaPermitida(endereco: string, politica: PoliticaDeSaida): VeredictoDeSaida {
  if (politica.dominios.length === 0) return { kind: 'RECUSADO', motivo: 'SEM_AUTORIZACAO', detalhe: endereco }
  let url: URL
  try { url = new URL(endereco) } catch { return { kind: 'RECUSADO', motivo: 'ESQUEMA_RECUSADO', detalhe: endereco } }
  if (url.protocol !== 'https:') return { kind: 'RECUSADO', motivo: 'ESQUEMA_RECUSADO', detalhe: url.protocol }
  // Credencial no endereço vaza pelo registro de acesso e pelo cabeçalho
  // `Referer` do salto seguinte. Ela também não tem uso legítimo aqui: a
  // pesquisa lê fonte pública, e fonte que exige senha não é fonte citável.
  if (url.username !== '' || url.password !== '') {
    return { kind: 'RECUSADO', motivo: 'CREDENCIAL_NO_ENDERECO', detalhe: url.host }
  }
  const canonico = hostCanonico(url.hostname)
  // A mesma normalização do destino de integração: o IPv4 embutido em IPv6, o
  // ponto final do nome absoluto e as faixas internas por NÚMERO.
  if (hostBloqueado(canonico)) return { kind: 'RECUSADO', motivo: 'HOST_INTERNO', detalhe: canonico.texto }
  // Literal de endereço nunca casa com um domínio da lista, e é bom que não
  // case: autorizar `exemplo.com` não autoriza falar com o IP dele hoje.
  if (canonico.forma !== 'NOME') return { kind: 'RECUSADO', motivo: 'FORA_DA_LISTA', detalhe: canonico.texto }
  if (!politica.dominios.some(dominio => dominioCobre(canonico.texto, dominio))) {
    return { kind: 'RECUSADO', motivo: 'FORA_DA_LISTA', detalhe: canonico.texto }
  }
  return { kind: 'PERMITIDO', host: canonico.texto }
}

/**
 * Se um redirecionamento pode ser seguido.
 *
 * Cada salto passa pela MESMA porta que o primeiro endereço. Seguir o `Location`
 * porque o endereço inicial era autorizado é como conferir a assinatura de um
 * documento e depois ler outro: um domínio autorizado que redireciona para
 * dentro da rede é a forma mais barata de atravessar esta política.
 * @param destino - o endereço do redirecionamento.
 * @param politica - a política em vigor.
 * @param saltosJaDados - quantos redirecionamentos já foram seguidos.
 * @returns o veredito.
 */
export function saltoPermitido(destino: string, politica: PoliticaDeSaida, saltosJaDados: number): VeredictoDeSaida {
  if (saltosJaDados >= MAX_SALTOS) return { kind: 'RECUSADO', motivo: 'SALTOS_DEMAIS', detalhe: String(saltosJaDados) }
  return saidaPermitida(destino, politica)
}

/**
 * Lê a política das variáveis de ambiente.
 *
 * Ausente é VAZIA, e vazia recusa. Não há valor padrão com domínios dentro: um
 * padrão que autoriza é uma autorização que ninguém deu, e ela entraria em toda
 * instalação sem aparecer em decisão nenhuma.
 * @param env - as variáveis de ambiente.
 * @returns a política.
 */
export function politicaDoAmbiente(env: Readonly<Record<string, string | undefined>>): PoliticaDeSaida {
  const bruto = env['DZ23_RESEARCH_EGRESS'] ?? ''
  const dominios = bruto.split(',').map(valor => valor.trim().toLowerCase()).filter(valor => valor !== '')
  // Um domínio com barra, esquema ou curinga é entrada malformada, e entrada
  // malformada numa lista de autorização é recusada em vez de interpretada.
  const validos = dominios.filter(valor => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/u.test(valor))
  return { dominios: validos }
}
