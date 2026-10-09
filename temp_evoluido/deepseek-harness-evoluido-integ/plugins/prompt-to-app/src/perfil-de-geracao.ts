import { z } from 'zod'
import type { StudioProjectCategory } from './model.js'

/**
 * O PERFIL DE GERAÇÃO: quanto de lógica o aplicativo gerado pode ter dentro.
 *
 * ## Por que ele existe
 *
 * Até 18/09/2026 havia um perfil só, e ele era declarativo: `import-policy.ts`
 * recusava `useState`, `onClick` e QUALQUER chamada de função. Isso não era
 * descuido — é o que impede o aplicativo gerado de tocar rede, disco e host, e
 * foi medido funcionando. O efeito colateral é que nenhum aplicativo com
 * comportamento podia existir: um jogo da velha que o modelo descrevesse
 * corretamente seria recusado na hora de escrever o código.
 *
 * ## O que muda entre os dois perfis, e o que NUNCA muda
 *
 * `interativo` libera TRÊS construções, e só três: atributos de evento (`onX`),
 * chamada de função e construtor. É o suficiente para estado, cálculo e reação
 * ao clique — que é o que faz um aplicativo ser um aplicativo.
 *
 * Tudo o mais continua igual nos dois: globais proibidos, APIs de rede,
 * `eval`/`Function`, `import.meta`, acesso dinâmico a propriedade,
 * `constructor`/`__proto__`/`prototype`, fábricas de elemento, tags perigosas,
 * `dangerouslySetInnerHTML`, espalhamento em JSX, URL insegura e a lista de
 * módulos importáveis. Essas guardas são ORTOGONAIS à interatividade: nenhuma
 * delas existe para impedir um clique, e nenhuma delas é afrouxada aqui.
 *
 * `ref` continua proibido nos dois. Ele é a porta para o DOM cru, e nenhum
 * aplicativo desta lista precisou dele até agora — quando precisar, é um delta
 * próprio, com o seu próprio exame.
 *
 * ## O que este arquivo NÃO é
 *
 * Não é o isolamento. Análise estática não substitui sandbox: ela é a camada
 * que recusa cedo o que a sandbox teria de conter depois. O isolamento real do
 * build, da execução e da prévia continua sendo o que separa o aplicativo
 * gerado do processo que o constrói.
 */

export const PERFIS_DE_GERACAO = ['declarativo', 'interativo'] as const
export const perfilDeGeracaoSchema = z.enum(PERFIS_DE_GERACAO)
export type PerfilDeGeracao = typeof PERFIS_DE_GERACAO[number]

/**
 * O perfil que cada categoria PRECISA para existir.
 *
 * `Record` exaustivo: uma categoria nova não compila sem uma resposta aqui, e a
 * resposta tem de ser pensada — é a diferença entre um aplicativo que reage ao
 * clique e um que só mostra conteúdo.
 *
 * Repare que isto é o que a categoria EXIGE, e não o que ela GANHA. A diferença
 * aparece em `perfilEfetivo`: exigir não é receber.
 */
export const PERFIL_EXIGIDO_POR_CATEGORIA: Readonly<Record<StudioProjectCategory, PerfilDeGeracao>> = {
  /*
    As sete formas conhecidas continuam DECLARATIVAS, e isso é deliberado.

    Elas funcionam assim hoje, estão provadas assim, e não há um pedido atrás
    delas pedindo comportamento. Promovê-las junto seria afrouxar, de graça, o
    perfil de todo aplicativo que já funciona — o oposto do que esta mudança se
    propõe.
  */
  'landing-page': 'declarativo',
  catalog: 'declarativo',
  'form-database': 'declarativo',
  'crud-panel': 'declarativo',
  scheduling: 'declarativo',
  dashboard: 'declarativo',
  'saas-authenticated': 'declarativo',
  // A categoria sem forma declarada é a única que nasce precisando de lógica:
  // foi a pessoa que descreveu o comportamento, e ele não cabe em JSX parado.
  outro: 'interativo',
}

/** O que a instalação autoriza. */
export interface AutorizacaoDeGeracao {
  /** Os perfis que ESTA instalação permite. `declarativo` está sempre aqui. */
  readonly permitidos: readonly PerfilDeGeracao[]
}

export type EscolhaDePerfil =
  | { readonly tipo: 'AUTORIZADO'; readonly perfil: PerfilDeGeracao }
  | { readonly tipo: 'NAO_AUTORIZADO'; readonly exigido: PerfilDeGeracao }

/**
 * O perfil que vale, e a recusa quando ele não é autorizado.
 *
 * ## Categoria descreve o pedido; ela não concede privilégio
 *
 * Esta separação é o ponto do arquivo. A categoria diz o que o aplicativo
 * PRECISA; a instalação diz o que ela PERMITE; e o perfil efetivo é a
 * interseção. Uma instalação trancada no declarativo continua trancada, mesmo
 * que alguém peça um jogo.
 *
 * ## Por que recusar em vez de rebaixar
 *
 * Rebaixar para `declarativo` produziria um jogo da velha sem cliques — um
 * aplicativo que nasce quebrado e não diz por quê. A pessoa mexeria nele
 * procurando o defeito, e o defeito seria uma decisão que ninguém mostrou. A
 * recusa nomeia a causa: a instalação não autoriza esse perfil.
 *
 * ## O modelo não tem entrada aqui
 *
 * O perfil é deduzido da categoria do PROJETO, que é um registro do servidor. O
 * modelo não escreve categoria, não escolhe perfil e não recebe campo por onde
 * pedir um. Se um dia ele devolver algo parecido com isso, o valor é ignorado
 * por construção: esta função só lê o registro.
 * @param categoria - a categoria do projeto.
 * @param autorizacao - o que a instalação permite.
 * @returns o perfil autorizado, ou a recusa.
 */
export function perfilEfetivo(categoria: StudioProjectCategory, autorizacao: AutorizacaoDeGeracao): EscolhaDePerfil {
  const exigido = PERFIL_EXIGIDO_POR_CATEGORIA[categoria]
  if (exigido === undefined) return { tipo: 'NAO_AUTORIZADO', exigido: 'interativo' }
  return autorizacao.permitidos.includes(exigido)
    ? { tipo: 'AUTORIZADO', perfil: exigido }
    : { tipo: 'NAO_AUTORIZADO', exigido }
}

/**
 * A autorização de uma instalação, lida do ambiente.
 *
 * `declarativo` está SEMPRE permitido: é o perfil de tudo o que já funciona, e
 * uma instalação sem ele não conseguiria gerar nem uma página. O interativo é
 * ligado por configuração, e o padrão é LIGADO porque o proprietário decidiu
 * que o produto não pode ser limitado a sete formas — a variável existe para
 * quem quiser o contrário, e não para fingir que existe uma escolha.
 * @param ambiente - as variáveis de ambiente.
 * @returns a autorização.
 */
export function autorizacaoDoAmbiente(ambiente: Readonly<Record<string, string | undefined>>): AutorizacaoDeGeracao {
  const desligado = ambiente.DZ23_GERACAO_INTERATIVA === 'nao'
  return { permitidos: desligado ? ['declarativo'] : ['declarativo', 'interativo'] }
}
