import { BIBLIOTECA_PATH, HABILIDADES_PATH, PLUGINS_PATH } from '../destinos/destinos'

/**
 * O que existe dentro das Preferências, e o que ainda NÃO existe.
 *
 * O quadro F04 da referência mostra treze itens em três grupos. Desenhá-los
 * todos seria o botão mudo que a decisão do proprietário proíbe por escrito:
 * um seletor de idioma com um idioma só, um seletor de tema que não troca tema
 * e uma página de uso e faturamento sem medição nenhuma.
 *
 * Então esta função devolve os treze — com a VERDADE de cada um ao lado. Quem
 * desenha não decide: item indisponível vira frase que diz o que falta, nunca
 * um controle que a pessoa aperta e nada acontece.
 *
 * É função pura porque a regra que importa é essa correspondência, e uma
 * decisão dentro de um JSX não é exercitada por teste nenhum — a lição que
 * este repositório já pagou mais de dez vezes.
 */

/** Os grupos, na ordem em que a referência os mostra. */
export type GrupoDePreferencias = 'configuracoes' | 'capacidades' | 'dados'

export interface SecaoDePreferencias {
  readonly id: string
  readonly grupo: GrupoDePreferencias
  /**
   * Se a seção tem alguma coisa que FUNCIONA. Quando é `false`, quem desenha
   * mostra o motivo e NENHUM controle.
   */
  readonly disponivel: boolean
  /** O que falta, quando falta. Sempre presente quando `disponivel` é `false`. */
  readonly pendencia?: string
  /** O destino que já existe para esta capacidade, quando existe. */
  readonly href?: string
}

/** O que a tela sabe sobre o ambiente na hora de montar as preferências. */
export interface ContextoDasPreferencias {
  /** Se há sessão — sem ela não há conta para mostrar. */
  readonly autenticado: boolean
  /** Se o navegador oferece a API de notificação. */
  readonly notificacoesSuportadas: boolean
}

/**
 * As seções das Preferências, na ordem da referência.
 *
 * As pendências não são desculpa: cada uma nomeia o trabalho que falta, e esse
 * trabalho está no DAG. "Ainda não existe" é resposta diferente de "não vai
 * existir" e de "está pronto".
 * @param contexto - o que a tela sabe do ambiente.
 * @returns as seções, com a verdade de cada uma.
 */
export function secoesDePreferencias(contexto: ContextoDasPreferencias): readonly SecaoDePreferencias[] {
  return [
    {
      id: 'conta', grupo: 'configuracoes', disponivel: contexto.autenticado,
      ...(contexto.autenticado ? {} : { pendencia: 'semSessao' }),
    },
    {
      id: 'notificacoes', grupo: 'configuracoes', disponivel: contexto.notificacoesSuportadas,
      ...(contexto.notificacoesSuportadas ? {} : { pendencia: 'semNotificacao' }),
    },
    /*
      O tema NÃO entra como controle, e a medida está no livro mestre, com
      data: em 18/09/2026 havia 688 ocorrências de cor fora dos tokens nas
      folhas da interface, 511 delas só em `styles.css`. Um tema claro que só
      pinta metade da tela é pior que um tema claro que ainda não existe.

      O NÚMERO saiu do texto que a pessoa lê, e isso é conserto de um defeito
      real: a frase dizia "506", o produto tinha 688, e os três catálogos
      passaram a discordar entre si no dia em que as traduções foram escritas.
      Uma contagem escrita à mão numa frase de interface não tem como continuar
      honesta — a medição vive no livro mestre, onde é datada.
    */
    { id: 'tema', grupo: 'configuracoes', disponivel: false, pendencia: 'temaUnico' },
    /*
      IDIOMA passou a ser disponível quando o produto passou a ter TRÊS.

      A pendência anterior dizia que o produto falava só português, e ela estava
      certa enquanto foi escrita: um seletor com um idioma só é um botão que não
      faz nada. O adendo `FRIGG-CONTA-APOIADOR-INTERNACIONAL-R2` trouxe inglês e
      espanhol de verdade — com catálogo, seleção e persistência —, e a partir
      daí a pendência passaria a descrever errado o produto, que é o defeito que
      este repositório trata como segunda verdade.

      A COBERTURA ainda é parcial, e a tela diz isso em vez de fingir: navegação
      e Preferências nos três idiomas; as demais telas, por enquanto, não.
    */
    { id: 'idioma', grupo: 'configuracoes', disponivel: true },
    /*
      ATALHOS passou a ser disponível quando o produto passou a TER um.

      A pendência anterior dizia que não havia atalho nenhum, e a medição achou
      `Esc` em três lugares — nenhum deles escrito em parte alguma. Um atalho
      que ninguém sabe que existe não é um atalho, e listar só os três também
      não fecharia o requisito. A fatia acrescentou o que faltava de verdade:
      enviar sem tirar a mão do teclado.
    */
    { id: 'atalhos', grupo: 'configuracoes', disponivel: true },
    /*
      USO passou a ser DISPONÍVEL, e a pendência que estava aqui estava ERRADA.

      Ela dizia "a medição de uso ainda não foi construída". A verificação do
      `T-35` provou o contrário, critério a critério: o consumo é gravado por
      inquilino e por rota, com tokens, custo estimado, chamadas não
      precificadas e teto com veredito, e sobrevive a reinício. O que faltava
      era a APRESENTAÇÃO fora da tarefa.

      Uma pendência que descreve errado o produto é uma segunda verdade com
      outra roupa: quem a lê constrói de novo o que já existe.
    */
    { id: 'uso', grupo: 'configuracoes', disponivel: true },
    { id: 'habilidades', grupo: 'capacidades', disponivel: true, href: HABILIDADES_PATH },
    { id: 'plugins', grupo: 'capacidades', disponivel: true, href: PLUGINS_PATH },
    { id: 'computador', grupo: 'capacidades', disponivel: false, pendencia: 'semComputador' },
    { id: 'biblioteca', grupo: 'dados', disponivel: true, href: BIBLIOTECA_PATH },
    /*
      CONTROLES DE DADOS passou a ser disponível com a operação que NÃO é
      destrutiva: levar consigo. Apagar continua fora, e a tela diz isso — é
      ação destrutiva e depende de decisão do dono do produto.
    */
    { id: 'privacidade', grupo: 'dados', disponivel: true },
    { id: 'implantacoes', grupo: 'dados', disponivel: false, pendencia: 'semImplantacao' },
  ]
}

/**
 * A seção que abre quando as Preferências abrem.
 *
 * A primeira DISPONÍVEL, e não a primeira da lista: abrir numa página que só
 * diz "ainda não existe" faria as Preferências parecerem vazias para quem tem
 * conta, notificação e três destinos funcionando.
 * @param secoes - as seções montadas.
 * @returns o identificador da seção inicial, ou `null` quando nenhuma serve.
 */
export function secaoInicial(secoes: readonly SecaoDePreferencias[]): string | null {
  return secoes.find(secao => secao.disponivel)?.id ?? null
}

/**
 * Se esta seção pode desenhar controle.
 *
 * Existe como função, e não como `secao.disponivel` espalhado pelo JSX, para
 * que a regra tenha UM lugar e um teste. Botão mudo entrou neste produto
 * exatamente assim: um `disabled` escrito à mão numa tela, longe da decisão.
 * @param secao - a seção.
 * @returns `true` quando há o que operar.
 */
export function podeOperar(secao: SecaoDePreferencias): boolean {
  return secao.disponivel
}
