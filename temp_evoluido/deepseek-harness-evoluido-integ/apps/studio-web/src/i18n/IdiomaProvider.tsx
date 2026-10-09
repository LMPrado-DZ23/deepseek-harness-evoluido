import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { catalogosDe, type Catalogos } from './catalogos'
import {
  IDIOMA_PADRAO, escolhaGuardada, guardarEscolha, idiomaEfetivo, idiomaNegociado,
  tagDoDocumento, type EscolhaDeIdioma, type Idioma,
} from './idioma'

/**
 * O IDIOMA vivo da interface, e os catálogos que ele escolhe.
 *
 * ## Por que um contexto, e não uma variável de módulo
 *
 * Porque trocar o idioma tem de REDESENHAR a tela, e uma variável de módulo não
 * avisa ninguém. Com o contexto, a troca é um `setState` e o React redesenha o
 * que lê texto — sem recarregar a página, sem refazer login, sem perder
 * rascunho e sem criar tarefa, que é exatamente o que o adendo exige.
 *
 * ## O que a troca NÃO faz
 *
 * Não toca em moeda, preço, permissão, tarefa, histórico nem horário de
 * agendamento. Este arquivo inteiro não importa nada disso, e é essa a prova
 * mais barata de que não mexe: não há como.
 */

interface ContextoDeIdioma {
  readonly idioma: Idioma
  readonly catalogos: Catalogos
  /** `false` quando o navegador recusou guardar a escolha. */
  readonly guardado: boolean
  readonly escolher: (idioma: Idioma) => void
}

/*
  O valor padrão do contexto é o PORTUGUÊS, e não `undefined`.

  Um componente montado fora do provedor — num teste de unidade, numa tela
  isolada — continua desenhando texto de verdade, em vez de explodir. A
  alternativa, lançar, transformaria uma configuração de teste em falha de
  produto.
*/
const Contexto = createContext<ContextoDeIdioma>({
  idioma: IDIOMA_PADRAO,
  catalogos: catalogosDe(IDIOMA_PADRAO),
  guardado: true,
  escolher: () => {},
})

/** O que o provedor precisa saber do mundo. Injetável para o teste não depender do navegador. */
export interface AmbienteDoIdioma {
  readonly armazem?: Pick<Storage, 'getItem' | 'setItem'> | undefined
  /**
   * A preferência que veio da CONTA, quando houver conta ligada.
   *
   * Hoje ela é sempre ausente: a fonte da conta não está conectada a este
   * provedor, e o adendo internacional ainda não decidiu o gateway. Ela está
   * declarada aqui — e coberta por teste — porque a precedência tinha de ser
   * resolvida ANTES de a fonte existir, e não depois, quando o defeito já
   * estaria na frente de alguém.
   */
  readonly daConta?: EscolhaDeIdioma | null
  readonly tagsDoNavegador?: readonly string[]
  readonly agora?: () => number
  /** Onde o `lang` é escrito. Ausente em servidor. */
  readonly documento?: { lang: string } | undefined
}

/**
 * O ambiente real do navegador, lido com cuidado.
 *
 * Cada acesso é protegido porque os três podem faltar ou lançar: em renderização
 * no servidor não há `window`, e em janela anônima o armazenamento lança ao ser
 * tocado. Uma exceção aqui derrubaria a aplicação antes do primeiro render, por
 * causa de uma preferência de apresentação.
 * @returns o ambiente.
 */
export function ambienteDoNavegador(): AmbienteDoIdioma {
  let armazem: Pick<Storage, 'getItem' | 'setItem'> | undefined
  try {
    armazem = typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    armazem = undefined
  }
  const navegador = typeof navigator === 'undefined' ? undefined : navigator
  return {
    armazem,
    tagsDoNavegador: navegador?.languages ?? (navegador?.language === undefined ? [] : [navegador.language]),
    documento: typeof document === 'undefined' ? undefined : document.documentElement,
  }
}

/**
 * O provedor do idioma.
 * @param props - os filhos e, opcionalmente, o ambiente.
 * @returns o provedor montado.
 */
export function IdiomaProvider({ children, ambiente = ambienteDoNavegador() }: {
  readonly children: ReactNode
  readonly ambiente?: AmbienteDoIdioma
}) {
  const agora = ambiente.agora ?? (() => Date.now())
  /*
    O estado NASCE com o que já estava guardado.

    Calcular na inicialização preguiçosa do `useState`, e não num efeito, é o
    que evita o "flash de idioma incorreto": com o efeito, o primeiro quadro
    sairia em português e o segundo no idioma da pessoa, e ela veria a tela
    trocar de língua na frente dela.
  */
  const [escolha, setEscolha] = useState<EscolhaDeIdioma | null>(() => escolhaGuardada(ambiente.armazem))
  /*
    A troca feita NESTA sessão é guardada separada da preferência lida do disco.

    As duas são "a escolha da pessoa", mas não têm a mesma força. Uma revisão
    externa apontou, antes de a preferência da conta existir, que comparar as
    duas por relógio deixaria a resposta atrasada da conta desfazer a troca que
    a pessoa acabou de fazer — a tela mudaria de idioma sozinha, na frente dela.
    Separando-as, esse caso deixa de depender de relógio: o que a pessoa fez
    agora vence, e ponto.
  */
  const [daSessao, setDaSessao] = useState<Idioma | null>(null)
  const [guardado, setGuardado] = useState(true)

  const idioma = idiomaEfetivo({
    daSessao,
    local: escolha,
    daConta: ambiente.daConta ?? null,
    doNavegador: idiomaNegociado(ambiente.tagsDoNavegador ?? []),
  })

  const escolher = useCallback((novo: Idioma) => {
    const feita: EscolhaDeIdioma = { idioma: novo, em: agora() }
    setDaSessao(novo)
    setEscolha(feita)
    // A escolha vale MESMO se não der para guardar: perder a troca no instante
    // em que a pessoa a fez seria pior que esquecê-la no próximo carregamento.
    setGuardado(guardarEscolha(ambiente.armazem, feita))
  }, [agora, ambiente.armazem])

  /*
    `html.lang` não é decoração: é o que diz ao leitor de tela em que língua
    pronunciar. Um `lang` errado faz a frase sair incompreensível para quem
    depende dele — e é por isso que ele acompanha o idioma efetivo, e não a
    escolha guardada.
  */
  useEffect(() => {
    if (ambiente.documento !== undefined) ambiente.documento.lang = tagDoDocumento(idioma)
  }, [ambiente.documento, idioma])

  const valor = useMemo<ContextoDeIdioma>(
    () => ({ idioma, catalogos: catalogosDe(idioma), guardado, escolher }),
    [idioma, guardado, escolher],
  )
  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>
}

/**
 * O idioma vivo e os catálogos dele.
 * @returns o contexto do idioma.
 */
export function useIdioma(): ContextoDeIdioma {
  return useContext(Contexto)
}

/**
 * Os catálogos do idioma vivo — o atalho que a maioria das telas usa.
 * @returns os catálogos.
 */
export function useCatalogos(): Catalogos {
  return useContext(Contexto).catalogos
}
