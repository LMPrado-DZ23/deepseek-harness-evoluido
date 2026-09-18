import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import {
  ExternalLink, Home, Maximize2, Minimize2, Monitor, RefreshCw, Smartphone,
} from 'lucide-react'
import { useCatalogos } from '../i18n/IdiomaProvider'
import { situacaoDoPainel, type LeituraDoPainel, type SituacaoDoPainel } from './estado'
import { LARGURA_DO_VIEWPORT, type Modo, type Viewport } from './layout'
import { ROTA_INICIAL, enderecoDoQuadro, rotaAnunciada, rotaDaPrevia, type RotaRecusada } from './navegacao'
import { mensagemDaPrevia } from './mensagens'
import { ABAS, abaEfetiva, abasDoPainel, type Aba, type LeituraDasAbas } from './abas'

/**
 * O PAINEL DE PRÉVIA: o aplicativo da pessoa, ao lado da conversa dela.
 *
 * ## O que ele mostra, e o que ele se recusa a mostrar
 *
 * Enquanto não existe uma versão executável autorizada, ele mostra a
 * PREPARAÇÃO — com nome, detalhe e sem porcentagem inventada. Quem decide isso
 * é `situacaoDoPainel`, que tem teste próprio; aqui só há desenho. Essa
 * separação é a lição mais repetida deste repositório: decisão dentro de JSX
 * não é exercitada por teste nenhum.
 *
 * ## As três operações que as pessoas confundem
 *
 * Fechar o painel, encerrar a prévia e cancelar a tarefa são três coisas. Este
 * componente faz a primeira e pede a segunda; a terceira não está aqui, e nunca
 * vai estar — a única destrutiva das três não mora num botão de painel.
 *
 * ## O que chega de dentro do quadro
 *
 * É dado, nunca instrução. A origem e a janela são conferidas antes, e o corpo
 * passa por `mensagemDaPrevia`, cujo vocabulário não tem como autorizar nada.
 */
export function PainelDePrevia({
  leitura, base, modo, viewport, aoExpandir, aoRestaurar, aoTrocarViewport, aoEncerrar, aoRecarregar,
  entrada, refDoQuadro, codigos = [], leituraDasAbas, arquivos, testes, historico,
}: {
  readonly leitura: LeituraDoPainel
  /** O endereço da prévia, quando ela existe. */
  readonly base: string | null
  readonly modo: Modo
  readonly viewport: Viewport
  aoExpandir(): void
  aoRestaurar(): void
  aoTrocarViewport(viewport: Viewport): void
  /** Encerrar a PRÉVIA — que não é cancelar a tarefa. */
  aoEncerrar?: () => void
  aoRecarregar?: () => void
  /**
   * O endereço da PRIMEIRA carga, quando ela não é a raiz do aplicativo.
   *
   * A prévia entra por `/__dz23/admission`: é lá que o bilhete é trocado pelo
   * cookie do host dela. Mandar a primeira carga para `/` pularia a troca, e o
   * aplicativo abriria sem sessão — o quadro pareceria funcionar e nada dentro
   * dele funcionaria. Depois que a pessoa navega, o endereço passa a sair da
   * rota, porque aí a sessão já existe.
   */
  readonly entrada?: string | null
  /** O quadro, para quem detém o bilhete poder falar com ele. */
  readonly refDoQuadro?: Ref<HTMLIFrameElement>
  /**
   * Os códigos de acesso que o aplicativo gerado pediu, quando ele pede algum.
   *
   * Um aplicativo com entrada por código manda o código para um endereço que
   * ninguém lê numa prévia local. Sem mostrá-lo aqui, a pessoa fica presa na
   * porta do próprio aplicativo — e, pior, sem saber por quê. O texto ao lado
   * diz que ele NÃO foi enviado por e-mail, para ninguém procurar na caixa.
   */
  readonly codigos?: readonly { readonly email: string; readonly code: string; readonly expires_at: string }[]
  /** O que o painel sabe para decidir quais abas abrem. */
  readonly leituraDasAbas?: LeituraDasAbas
  /** O conteúdo de cada aba, montado por quem tem acesso aos dados. */
  readonly arquivos?: ReactNode
  readonly testes?: ReactNode
  readonly historico?: ReactNode
}) {
  const { previa } = useCatalogos()
  const situacao: SituacaoDoPainel = situacaoDoPainel(leitura)
  const [rota, setRota] = useState<string>(ROTA_INICIAL)
  /** Se a pessoa já navegou. Antes disso, a carga é a da ENTRADA. */
  const [navegou, setNavegou] = useState(false)
  const [rascunhoDaRota, setRascunhoDaRota] = useState<string>(ROTA_INICIAL)
  const [recusa, setRecusa] = useState<RotaRecusada | null>(null)
  const [erroDoAplicativo, setErroDoAplicativo] = useState<string | null>(null)
  /*
    A chave do quadro força a RECARGA sem tocar no endereço. Trocar `src` pelo
    mesmo valor não recarrega nada, e recarregar pelo `contentWindow` exigiria
    alcançar o documento de dentro — que é justamente o que o isolamento impede.
  */
  const [geracao, setGeracao] = useState(0)
  const quadro = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    if (base === null) return
    const origem = new URL(base).origin
    const ouvir = (evento: MessageEvent) => {
      // Origem E janela: a primeira sozinha aceita qualquer aba daquele host.
      if (evento.origin !== origem || evento.source !== quadro.current?.contentWindow) return
      const mensagem = mensagemDaPrevia(evento.data)
      if (mensagem === null) return
      if (mensagem.tipo === 'ERRO') setErroDoAplicativo(mensagem.mensagem)
      if (mensagem.tipo === 'MUDOU_DE_ROTA') {
        // A rota ANUNCIADA passa pela mesma conferência da digitada: um
        // aplicativo que anuncie outro site não move o quadro para fora.
        const seguida = rotaAnunciada(mensagem.caminho)
        if (seguida !== null) setRascunhoDaRota(seguida)
      }
    }
    window.addEventListener('message', ouvir)
    return () => { window.removeEventListener('message', ouvir) }
  }, [base])

  function irPara(caminho: string) {
    const escolhida = rotaDaPrevia(caminho)
    if (escolhida.tipo === 'RECUSADA') { setRecusa(escolhida.motivo); return }
    setRecusa(null)
    setRota(escolhida.caminho)
    setRascunhoDaRota(escolhida.caminho)
    setNavegou(true)
  }

  const [abaEscolhida, setAbaEscolhida] = useState<Aba>('previa')
  /*
    Sem leitura das abas, o painel é SÓ a prévia — que é como ele nasceu e como
    ele continua para quem o monta sem passar os dados. Uma barra de abas vazia
    seria pior que nenhuma: ela promete seções que ninguém ligou.
  */
  const estadosDasAbas = leituraDasAbas === undefined ? null : abasDoPainel(leituraDasAbas)
  const aba = estadosDasAbas === null ? 'previa' : abaEfetiva(estadosDasAbas, abaEscolhida)
  const estadoDaAbaAtual = estadosDasAbas?.find(item => item.aba === aba) ?? null
  const conteudoDaAba: Readonly<Record<Aba, ReactNode>> = { previa: null, arquivos, testes, historico }

  const largura = LARGURA_DO_VIEWPORT[viewport]
  const chave = `${situacao.situacao}-${geracao}`
  const enderecoDaCarga = !navegou && entrada != null ? entrada : enderecoDoQuadro(base ?? '', rota)

  return <section className="dz-previa" aria-label={previa.rotulo}>
    <header className="dz-previa-topo">
      <p className="dz-previa-situacao" role="status">
        <strong>{previa.situacao[situacao.situacao]}</strong>
        <span>{previa.situacao[`${situacao.situacao}Detalhe` as keyof typeof previa.situacao]}</span>
      </p>
      {situacao.servindoVersaoAnterior
        ? <p className="dz-previa-anterior"><strong>{previa.versaoAnterior}</strong> {previa.versaoAnteriorAviso}</p>
        : null}
    </header>

    {estadosDasAbas === null ? null : <div className="dz-previa-abas" role="tablist" aria-label={previa.abas}>
      {estadosDasAbas.map(estado => <button key={estado.aba} type="button" role="tab"
        id={`dz-previa-aba-${estado.aba}`} aria-controls="dz-previa-conteudo"
        aria-selected={estado.aba === aba} onClick={() => { setAbaEscolhida(estado.aba) }}>
        {previa[`aba${estado.aba.charAt(0).toUpperCase()}${estado.aba.slice(1)}` as 'abaPrevia']}
      </button>)}
    </div>}

    <div id="dz-previa-conteudo" role="tabpanel" aria-labelledby={`dz-previa-aba-${aba}`} className="dz-previa-conteudo">
    {/*
      Um controle indisponível EXPLICA a dependência. Sumir faz a pessoa
      procurar o que não existe; ficar mudo faz ela clicar, nada acontecer, e
      concluir que o produto quebrou.
    */}
    {estadoDaAbaAtual !== null && !estadoDaAbaAtual.disponivel && estadoDaAbaAtual.motivo !== null
      ? <p className="dz-previa-ajuda">{previa.indisponivel[estadoDaAbaAtual.motivo]}</p>
      : aba !== 'previa' ? conteudoDaAba[aba] : null}

    {aba !== 'previa' ? null : <>
    {situacao.mostraAplicativo && base !== null ? <>
      <div className="dz-previa-controles">
        <button type="button" onClick={() => { irPara(ROTA_INICIAL) }} aria-label={previa.inicio}><Home aria-hidden="true" /></button>
        <button type="button" onClick={() => { setGeracao(valor => valor + 1); aoRecarregar?.() }} aria-label={previa.recarregar}><RefreshCw aria-hidden="true" /></button>
        <form className="dz-previa-rota" onSubmit={evento => { evento.preventDefault(); irPara(rascunhoDaRota) }}>
          <label htmlFor="dz-previa-rota-campo">{previa.rota}</label>
          <input id="dz-previa-rota-campo" value={rascunhoDaRota} onChange={evento => { setRascunhoDaRota(evento.target.value) }}
            aria-describedby="dz-previa-rota-ajuda" />
        </form>
        <div className="dz-previa-viewport" role="group" aria-label={previa.viewport}>
          <button type="button" aria-pressed={viewport === 'desktop'} onClick={() => { aoTrocarViewport('desktop') }}>
            <Monitor aria-hidden="true" /><span>{previa.desktop}</span>
          </button>
          <button type="button" aria-pressed={viewport === 'celular'} onClick={() => { aoTrocarViewport('celular') }}>
            <Smartphone aria-hidden="true" /><span>{previa.celular}</span>
          </button>
        </div>
        {/*
          O endereço da aba nova é o MESMO da prévia, com o bilhete de admissão
          que já governa o quadro. Ele não é público, não dispensa o isolamento
          e não carrega credencial nenhuma na barra.
        */}
        <a className="dz-previa-separado" href={enderecoDoQuadro(base, rota)} target="_blank" rel="noreferrer noopener">
          <ExternalLink aria-hidden="true" /><span>{previa.abrirSeparado}</span>
        </a>
        <button type="button" onClick={modo === 'expandido' ? aoRestaurar : aoExpandir}
          aria-label={modo === 'expandido' ? previa.restaurar : previa.expandir}>
          {modo === 'expandido' ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
        </button>
      </div>
      <p id="dz-previa-rota-ajuda" className="dz-previa-ajuda">{previa.rotaAjuda}</p>
      {recusa === null ? null : <p className="dz-previa-recusa" role="alert">{previa.rotaRecusada[recusa]}</p>}
      {viewport === 'celular' ? <p className="dz-previa-ajuda">{previa.celularAviso}</p> : null}
      <div className="dz-previa-quadro" style={largura === null ? undefined : { maxWidth: `${largura}px` }}>
        {/*
          `sandbox` sem `allow-top-navigation` e sem `allow-popups`: o que roda
          lá dentro não tira a pessoa desta tela nem abre janela por conta
          própria. `allow-same-origin` existe porque a admissão precisa de
          cookie do próprio host da prévia — que é um host só dela.
        */}
        <iframe key={chave} ref={refDoQuadro ?? quadro} title={previa.quadro} src={enderecoDaCarga}
          sandbox="allow-scripts allow-forms allow-same-origin" referrerPolicy="no-referrer" />
      </div>
      {codigos.length === 0 ? null : <section className="dz-previa-codigos" aria-live="polite">
        <h3>{previa.codigos}</h3>
        <p className="dz-previa-ajuda">{previa.codigosAjuda}</p>
        <ul>{codigos.map(item => <li key={`${item.email}-${item.expires_at}-${item.code}`}>
          <strong>{item.email}</strong>: <code>{item.code}</code>
        </li>)}</ul>
      </section>}
      {erroDoAplicativo === null ? null
        : <p className="dz-previa-erro" role="alert"><strong>{previa.erroDoAplicativo}</strong> <code>{erroDoAplicativo}</code></p>}
    </> : null}
    </>}
    </div>

    <footer className="dz-previa-rodape">
      <p className="truth">{previa.naoPublicado}</p>
      <p className="dz-previa-ajuda">{previa.fecharAjuda}</p>
      {aoEncerrar === undefined || !situacao.mostraAplicativo ? null : <>
        <button type="button" className="secondary compact" onClick={aoEncerrar}>{previa.encerrar}</button>
        <span className="dz-previa-ajuda">{previa.encerrarAjuda}</span>
      </>}
    </footer>
  </section>
}
