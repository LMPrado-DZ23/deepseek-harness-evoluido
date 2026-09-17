import { ArrowUp, CircleCheck, CircleSlash, FileText, FolderOpen, Loader, TriangleAlert, X } from 'lucide-react'
import { BuildSteps } from '../BuildSteps'
import { hasBuildSteps } from '../buildSteps'
import { attemptSentence, stageSentence } from '../creationProgress'
import { useEffect, useRef, useState } from 'react'
import tarefa from '../i18n/tarefa.pt-BR.json'
import { MenuDoCompositor } from './MenuDoCompositor'
import type { IntegracaoDoMenu } from './menusDoCompositor'
import { destinoDoEnvio, envioDisponivel, intencaoPadrao, type Destino, type Intencao } from './compositor'
import { transcricaoDaTarefa, type DetalhesDaTarefa, type Lance } from './transcricao'

/**
 * A tarefa como CONVERSA, que é a estrutura principal do workspace aprovado.
 *
 * A tela que esta substitui punha um relatório no meio e um trilho de cinco
 * caixas na direita, e o proprietário a recusou por isso — não pela cor. O que
 * muda aqui não é o tema: é onde as coisas moram. O histórico da tarefa ocupa a
 * coluna central, o compositor fica embaixo e alinhado com ela, e tudo o que
 * antes era painel permanente virou detalhe recolhível ou painel sob demanda.
 *
 * O pipeline de cinco fases continua INTEIRO por baixo. Perguntas de admissão,
 * plano, tentativas e critérios são os mesmos registros, com os mesmos estados
 * e as mesmas autorizações; o que mudou foi que eles são lidos por
 * `transcricaoDaTarefa` e apresentados em ordem, em vez de desenhados como
 * cinco etapas fixas. O detalhamento antigo não sumiu: ele abre no painel
 * lateral, que é o que a decisão chama de "visualização diagnóstica secundária".
 *
 * Esta é a casca da conversa. Ela NÃO chama o servidor: as ações chegam por
 * propriedade, do `App`, que continua sendo quem fala com a API e quem guarda o
 * estado da tarefa. Manter a chamada fora daqui é o que permite montar a
 * conversa inteira no teste sem servidor nenhum.
 */

export interface TaskScreenProps {
  readonly detalhes: DetalhesDaTarefa
  /** O que a pessoa está escrevendo. Mora no `App` para sobreviver a abrir e fechar painel. */
  readonly rascunho: string
  setRascunho(valor: string): void
  /** Responde à pergunta de admissão aberta. */
  responder(texto: string): Promise<void>
  /** Pede mudança no plano — mesma tarefa, revisão nova. */
  mudarPlano(texto: string): Promise<void>
  /** Pede um ajuste depois de um resultado. Continua na MESMA tarefa. */
  ajustar(texto: string): Promise<void>
  /** PERGUNTA sobre a tarefa. Não escreve critério de aceite nem gasta tentativa. */
  perguntar(texto: string): Promise<void>
  /** O painel contextual aberto, ou `null` quando a conversa está sozinha. */
  readonly painel: PainelAberto | null
  abrirPainel(painel: PainelAberto): void
  fecharPainel(): void
  /** O conteúdo do painel, montado pelo `App` (resultado, prévia, diagnóstico). */
  readonly conteudoDoPainel?: React.ReactNode
  /** As ações que só existem em certos estados: aprovar plano, criar, cancelar. */
  readonly acoesDoEstado?: React.ReactNode
  /** O que o Hub devolveu, para os menus do compositor. `null` é "ainda não li". */
  readonly integracoes?: readonly IntegracaoDoMenu[] | null
  /** As iniciais de quem está na sessão, para o avatar. `null` sem sessão. */
  readonly iniciais?: string | null
}

export type PainelAberto =
  | { readonly tipo: 'artefato'; readonly runId: string }
  | { readonly tipo: 'preview' }
  | { readonly tipo: 'diagnostico' }
  | { readonly tipo: 'uso' }

/**
 * A pergunta de admissão ainda sem resposta, se houver.
 * @param detalhes - o corpo da tarefa.
 * @returns o nome da pergunta aberta, ou `null`.
 */
export function perguntaAbertaDe(detalhes: DetalhesDaTarefa): string | null {
  return detalhes.next?.id ?? null
}

export function TaskScreen(props: TaskScreenProps) {
  const lances = transcricaoDaTarefa(props.detalhes)
  const situacao = {
    estado: props.detalhes.project.state,
    perguntaAberta: perguntaAbertaDe(props.detalhes),
  }
  const padrao = intencaoPadrao(situacao)
  const [intencao, setIntencao] = useState<Intencao>(padrao)
  /*
    O PADRÃO VOLTA A VALER quando o momento da tarefa muda.

    Sem isto, alguém que escolheu "pedir alteração" e depois viu o construtor
    rodar ficaria com a escolha antiga marcada por tempo indeterminado — e a
    escolha antiga é justamente a que grava critério de aceite. O padrão só
    caminha na direção segura: onde o defeito morava, ele é "perguntar".
  */
  useEffect(() => { setIntencao(padrao) }, [padrao, props.detalhes.project.project_id])
  const destino = destinoDoEnvio(situacao, intencao)
  const acaoDoEstado = destinoDoEnvio(situacao, 'agir')
  const [enviando, setEnviando] = useState(false)
  const fim = useRef<HTMLLIElement | null>(null)
  const podeEnviar = envioDisponivel(destino, props.rascunho) && !enviando

  /*
    A conversa desce sozinha quando um lance novo chega — e SÓ então. Descer a
    cada render roubaria a rolagem de quem subiu para reler o plano enquanto a
    tentativa corre, que é justamente quando alguém sobe.
  */
  useEffect(() => { fim.current?.scrollIntoView({ block: 'end' }) }, [lances.length])

  async function enviar(evento: React.FormEvent) {
    evento.preventDefault()
    if (!podeEnviar) return
    const texto = props.rascunho
    setEnviando(true)
    try {
      await despachar(destino, texto, props)
      // O rascunho só é limpo DEPOIS que o envio deu certo: limpar antes
      // apagaria o texto de quem perdeu a rede, e reescrever é o que ninguém
      // faz — a pessoa desiste.
      props.setRascunho('')
    } finally { setEnviando(false) }
  }

  /*
    O compositor DIZ o que o envio vai fazer, antes de a pessoa apertar.

    Depois de um resultado, o texto vira um pedido de alteração do aplicativo:
    ele entra na especificação como critério de aceite e custa um plano novo e
    uma tentativa. Fazer isso em silêncio transformava toda mensagem — inclusive
    uma pergunta — em critério permanente, que foi exatamente o defeito
    apontado. O aviso não é decoração: é o que separa "perguntei" de "mandei
    mudar o aplicativo".

    A correção COMPLETA é ligar a mensagem simples à autoridade de conversa que
    já existe, para perguntar não custar tentativa nenhuma. Isso é a fatia
    seguinte; até lá, o que o envio faz está escrito na tela.
  */
  /*
    DOIS AVISOS, e não um.

    O primeiro é FATO DA TAREFA — há trabalho correndo, o plano está aprovado
    e a criação não começou — e ele não depende do que a pessoa escolheu
    fazer: some-lo porque ela marcou "perguntar" esconderia o que está
    acontecendo justamente de quem perguntou. O segundo é sobre o ENVIO: o que
    aquele botão vai fazer com o texto dela.
  */
  const avisoDaTarefa = acaoDoEstado.tipo === 'aguardar'
    ? acaoDoEstado.motivo === 'execucao' ? tarefa.aguardandoTrabalho : tarefa.aguardandoAprovacao
    : null
  const avisoDoEnvio = destino.tipo === 'perguntar' ? tarefa.avisoPergunta
    : destino.tipo === 'ajustar' ? tarefa.avisoAjuste
      : null

  return <div className={props.painel === null ? 'dz-tarefa' : 'dz-tarefa dz-tarefa-com-painel'}>
    {/*
      `<main>` e não `<div>`: a página precisa de UM marco principal, e o axe
      reprovou as duas coisas que faltavam — `landmark-one-main`, porque a
      conversa não era marco nenhum, e `region`, porque o conteúdo dela ficava
      fora de qualquer região. A tela antiga tinha `<main className="canvas">`
      e a garantia veio junto com ela; recriá-la aqui é devolver o que a troca
      de estrutura levou.
    */}
    <main className="dz-tarefa-conversa">
      {/*
        O `<h1>` é o NOME DA TAREFA, e ele existe por `page-has-heading-one`:
        uma página sem título de primeiro nível deixa quem navega por títulos
        sem ponto de partida.

        Ele é `sr-only` porque o nome da tarefa JÁ está visível, no cabeçalho
        da casca. Desenhá-lo outra vez aqui punha a mesma frase duas vezes,
        uma embaixo da outra — e a referência não tem título sobre a conversa.
        Escondê-lo com `display: none` o tiraria também do leitor de tela, que
        é justamente quem precisa dele; `sr-only` o mantém no documento.
      */}
      <h1 className="sr-only">{props.detalhes.project.name.trim() === '' ? tarefa.semTitulo : props.detalhes.project.name}</h1>
      {/*
        `tabIndex={0}` porque a conversa ROLA. Uma região que rola e não recebe
        foco é inalcançável por teclado: quem não usa mouse não consegue subir
        para reler o plano. O axe apanhou isto (`scrollable-region-focusable`)
        no primeiro fluxo completo — a lista antiga não rolava sozinha, então a
        regra nunca tinha valido aqui.
      */}
      <ol className="dz-conversa" tabIndex={0} aria-label={tarefa.conversaRotulo}>
        {lances.map(lance => <li key={lance.id} className={`dz-lance dz-lance-${lance.autor}`}>
          {/*
            O AVATAR, como na referência: as iniciais de quem está na sessão
            para a pessoa, a marca para o estúdio. Ele é `aria-hidden` porque
            quem ouve a tela já recebe o autor em palavras, logo abaixo — o
            avatar repetiria a mesma informação em voz.
          */}
          <span className="dz-lance-avatar" aria-hidden="true">
            {lance.autor === 'pessoa' ? (props.iniciais ?? tarefa.voce.slice(0, 1)) : tarefa.marca}
          </span>
          <div className="dz-lance-corpo">
            <LanceView lance={lance} abrir={props.abrirPainel} />
          </div>
        </li>)}
        {/*
          A marca do fim mora DENTRO da lista que rola, e isso não é detalhe:
          `scrollIntoView` rola o ancestral que tem rolagem. Com a marca fora
          do `<ol>`, quem rolava era a página — e a conversa ficava parada no
          primeiro lance enquanto novos chegavam embaixo, sem ninguém ver.
        */}
        <li ref={fim} className="dz-fim" aria-hidden="true" />
      </ol>
      {props.acoesDoEstado === undefined ? null : <div className="dz-tarefa-acoes">{props.acoesDoEstado}</div>}

      {/*
        O compositor fica ABAIXO da conversa e reserva espaço real, em vez de
        flutuar sobre ela: na referência o último conteúdo continua legível com
        o compositor na tela, e uma caixa sobreposta esconde exatamente a última
        mensagem, que é a que interessa.
      */}
      <form className="dz-compositor dz-compositor-inferior" onSubmit={event => void enviar(event)}>
        {avisoDaTarefa === null ? null : <p className="dz-compositor-aviso" role="status">{avisoDaTarefa}</p>}
        {avisoDoEnvio === null ? null : <p className="dz-compositor-aviso dz-compositor-aviso-neutro" role="status">{avisoDoEnvio}</p>}
        {/*
          A ESCOLHA, e não a adivinhação.

          Classificar a frase — "isso parece uma pergunta" — seria a mesma
          automação que produziu o defeito, e erraria em silêncio. São dois
          botões de rádio de verdade, e não abas nem um interruptor: o leitor
          de tela anuncia "2 de 2 selecionado" e o teclado navega com as setas,
          que é o que um grupo de escolha exclusiva precisa fazer.
        */}
        <fieldset className="dz-compositor-intencao">
          <legend className="sr-only">{tarefa.intencaoRotulo}</legend>
          <label className={classes('dz-intencao-opcao', intencao === 'perguntar' ? 'dz-intencao-marcada' : null)}>
            <input type="radio" name="dz-intencao" value="perguntar" checked={intencao === 'perguntar'}
              onChange={() => setIntencao('perguntar')} />
            <span>{tarefa.intencaoPerguntar}</span>
          </label>
          <label className={classes('dz-intencao-opcao', intencao === 'agir' ? 'dz-intencao-marcada' : null)}>
            <input type="radio" name="dz-intencao" value="agir" checked={intencao === 'agir'}
              onChange={() => setIntencao('agir')} />
            <span>{rotuloDaAcao(acaoDoEstado)}</span>
          </label>
        </fieldset>
        <label className="sr-only" htmlFor="dz-continuar">{tarefa.compositorRotulo}</label>
        <textarea id="dz-continuar" rows={2} value={props.rascunho} maxLength={2000}
          placeholder={tarefa.compositorPlaceholder}
          onChange={evento => props.setRascunho(evento.target.value)} />
        <div className="dz-compositor-rodape">
          {/* O PROJETO da tarefa, como o vídeo mostra no compositor: ele diz a
              que trabalho o texto vai se juntar. É o nome real da tarefa. */}
          <span className="dz-compositor-projeto"><FolderOpen aria-hidden="true" /><span>{props.detalhes.project.name}</span></span>
          <MenuDoCompositor qual="habilidades" integracoes={props.integracoes ?? null} />
          <MenuDoCompositor qual="plugins" integracoes={props.integracoes ?? null} />
          <span className="dz-contador" aria-live="polite">{props.rascunho.length}</span>
          <button type="submit" className="dz-enviar-redondo" disabled={!podeEnviar} aria-busy={enviando}
            aria-label={enviando ? tarefa.enviando : tarefa.enviar}>
            <ArrowUp aria-hidden="true" />
          </button>
          <span className="sr-only" role="status">{enviando ? tarefa.enviando : ''}</span>
        </div>
      </form>
    </main>

    {props.painel === null ? null : <aside className="dz-painel" aria-label={tarefa.painelRotulo}>
      <header className="dz-painel-topo">
        <h2>{tituloDoPainel(props.painel)}</h2>
        <button type="button" className="dz-painel-fechar" onClick={props.fecharPainel}
          aria-label={tarefa.painelFechar}><X aria-hidden="true" /></button>
      </header>
      {/*
        `tabIndex={0}` porque o CORPO DO PAINEL rola. Uma região que rola e não
        recebe foco é inalcançável por teclado — é a mesma regra que já valia
        para a conversa (`scrollable-region-focusable`), e o axe só a cobrou
        aqui quando o painel passou a ter conteúdo mais alto que a janela: na
        máquina local o conteúdo cabia e a regra não valia; na CI, não coube.
      */}
      <div className="dz-painel-corpo" tabIndex={0}>{props.conteudoDoPainel}</div>
    </aside>}
  </div>
}

/**
 * Manda o texto para onde o destino disse, e para lugar nenhum além.
 *
 * O `switch` é exaustivo de propósito: um destino novo sem tratamento aqui
 * vira erro de tipo, e não um envio silencioso que não faz nada.
 * @param destino - o destino calculado pelo compositor.
 * @param texto - o que a pessoa escreveu.
 * @param props - as ações da tela.
 */
async function despachar(destino: Destino, texto: string, props: TaskScreenProps): Promise<void> {
  if (destino.tipo === 'perguntar') return props.perguntar(texto)
  if (destino.tipo === 'responder') return props.responder(texto)
  if (destino.tipo === 'mudar-plano') return props.mudarPlano(texto)
  if (destino.tipo === 'ajustar') return props.ajustar(texto)
  // `aguardar` e `abrir-tarefa` não chegam aqui: o primeiro é barrado por
  // `envioDisponivel` e o segundo só existe quando não há tarefa — e sem tarefa
  // esta tela não é montada.
}

/**
 * O nome do gesto que ESTE momento da tarefa espera.
 *
 * Ele é o rótulo da segunda opção, e muda com o momento: responder a pergunta
 * aberta, pedir mudança no plano proposto, pedir alteração do aplicativo. Um
 * rótulo fixo — "Enviar" — devolveria o silêncio que causou o defeito: a
 * pessoa não saberia que aquele envio escreve critério de aceite.
 * @param destino - o destino que valeria sem escolher perguntar.
 * @returns o rótulo, já em português.
 */
export function rotuloDaAcao(destino: Destino): string {
  if (destino.tipo === 'responder') return tarefa.acaoResponder
  if (destino.tipo === 'mudar-plano') return tarefa.acaoMudarPlano
  // `aguardar` mostra o mesmo rótulo de `ajustar` porque é o que a pessoa vai
  // poder fazer quando a espera acabar — e o envio fica desabilitado até lá.
  return tarefa.acaoAjustar
}

/**
 * Junta nomes de classe, ignorando os ausentes.
 *
 * Existe por causa do portão de idioma, e o motivo dele é bom: um literal com
 * espaço e palavra em português é, quase sempre, texto que deveria estar no
 * catálogo. Um nome de classe não é — e escrevê-lo em pedaços deixa o portão
 * olhar só o que ele precisa olhar, sem uma dispensa aberta no portão.
 * @param nomes - os nomes, com `null` para os que não se aplicam.
 * @returns a lista de classes.
 */
/**
 * A etapa em curso, na forma que as frases da criação esperam.
 * @param etapa - a etapa gravada na tentativa.
 * @param tentativa - o número da tentativa.
 * @returns o par que `stageSentence` e `attemptSentence` leem.
 */
function etapaCorrente(etapa: string, tentativa: number): { readonly stage: string; readonly attempt: number } {
  return { stage: etapa, attempt: tentativa }
}

function classes(...nomes: readonly (string | null)[]): string {
  return nomes.filter(nome => nome !== null).join(' ')
}

function tituloDoPainel(painel: PainelAberto): string {
  if (painel.tipo === 'preview') return tarefa.painelPreview
  if (painel.tipo === 'uso') return tarefa.painelUso
  if (painel.tipo === 'diagnostico') return tarefa.painelDiagnostico
  return tarefa.painelResultado
}

/** Os rótulos de estado, do catálogo, sem inventar um para o que não conhecemos. */
const ESTADO_LABEL: Readonly<Record<string, string>> = {
  PASSED: tarefa.estadoPASSED, FAILED: tarefa.estadoFAILED,
  BLOCKED_EXTERNAL: tarefa.estadoBLOCKED_EXTERNAL, BUDGET_EXCEEDED: tarefa.estadoBUDGET_EXCEEDED,
  CANCELLED: tarefa.estadoCANCELLED, RUNNING: tarefa.estadoRUNNING, PENDING: tarefa.estadoPENDING,
}
const ETAPA_LABEL: Readonly<Record<string, string>> = {
  generate: tarefa.etapaGenerate, build: tarefa.etapaBuild,
  test: tarefa.etapaTest, verify: tarefa.etapaVerify,
}

/**
 * O rótulo de um estado de tentativa.
 *
 * Um estado que este produto não conhece sai como ele mesmo, e não como uma
 * frase amigável escolhida no chute: dizer "tudo certo" sobre algo que não
 * sabemos ler é a certificação vazia que o aceite VIS-12 recusa.
 * @param estado - o estado gravado pelo servidor.
 * @returns a frase do catálogo, ou o próprio estado.
 */
export function rotuloDoEstado(estado: string): string {
  return ESTADO_LABEL[estado] ?? estado
}

function LanceView({ lance, abrir }: { lance: Lance; abrir(painel: PainelAberto): void }) {
  if (lance.tipo === 'pedido' || lance.tipo === 'resposta') {
    return <>
      <p className="dz-lance-autor">{tarefa.voce}</p>
      <p className="dz-lance-texto">{lance.texto}</p>
      {lance.tipo === 'resposta' && lance.recomendada ? <p className="dz-lance-nota">{tarefa.recomendada}</p> : null}
    </>
  }
  if (lance.tipo === 'pergunta') {
    return <>
      <p className="dz-lance-autor">{tarefa.estudioRespondeu}</p>
      <p className="dz-lance-texto">{lance.texto}</p>
    </>
  }
  if (lance.tipo === 'plano') {
    const estado = lance.status === 'APPROVED' ? tarefa.planoAprovado
      : lance.status === 'CHANGE_REQUESTED' ? tarefa.planoMudancaPedida : tarefa.planoTitulo
    return <>
      <p className="dz-lance-autor">{tarefa.estudioRespondeu}</p>
      <details className={classes('dz-bloco', 'dz-bloco-plano')}>
        <summary>{estado} · {tarefa.planoRevisao} {lance.revisao}</summary>
        {lance.escritoPelaPessoa ? <p className="dz-lance-nota">{tarefa.planoEscritoPelaPessoa}</p> : null}
        <ol className="dz-plano-fatias">{lance.fatias.map(fatiaDoPlano => <li key={fatiaDoPlano.slice_id}>
          <strong>{fatiaDoPlano.title}</strong>
          <p>{fatiaDoPlano.description}</p>
          <p className="dz-lance-nota">{tarefa.planoCriterios}</p>
          <ul>{fatiaDoPlano.acceptance_criteria.map(criterio => <li key={criterio}>{criterio}</li>)}</ul>
        </li>)}</ol>
      </details>
    </>
  }
  if (lance.tipo === 'execucao') {
    return <>
      <p className="dz-lance-autor">{tarefa.estudioRespondeu}</p>
      <div className="dz-bloco dz-bloco-trabalho">
        <p className="dz-trabalho-linha">
          {lance.emCurso ? <Loader aria-hidden="true" className="dz-girando" /> : <CircleCheck aria-hidden="true" />}
          <span>{ETAPA_LABEL[lance.etapa] ?? lance.etapa} · {tarefa.trabalhoTentativa} {lance.tentativa}</span>
          <span className="dz-lance-nota">{lance.emCurso ? tarefa.trabalhoEmCurso : rotuloDoEstado(lance.estado)}</span>
        </p>
        {/*
          A FRASE DA ETAPA veio da tela antiga, e veio inteira — mesma função,
          mesmas palavras, mesmo `aria-live`. Ela é a única coisa que separa
          "trabalhando" de "travado" quando a execução não tem passos
          registrados, que é o caso de todo servidor anterior ao campo `steps`.
          Ela ficava desenhada ao lado da linha do tempo, e as duas juntas
          repetiam a mesma palavra duas vezes na tela: aqui a frase aparece
          SÓ quando não há passos, como já era a regra.
        */}
        {!lance.emCurso || hasBuildSteps(lance.passos) ? null : <p className="creation-stage" aria-live="polite">
          <span className="creation-spinner" aria-hidden="true" />{stageSentence(etapaCorrente(lance.etapa, lance.tentativa))}
          {attemptSentence(etapaCorrente(lance.etapa, lance.tentativa)) === null ? null
            : <small>{attemptSentence(etapaCorrente(lance.etapa, lance.tentativa))}</small>}
        </p>}
        {/*
          A linha do tempo do construtor é a que já existe: os mesmos quatro
          passos, as mesmas frases, o mesmo tratamento para passo desconhecido.

          Ela vem ABERTA enquanto a tentativa corre e RECOLHIDA depois. As duas
          coisas são pedidos diferentes e os dois valem: "a ideia desse projeto
          é ver a construção em tempo real" é o motivo de ela existir, e é nos
          minutos da espera que ela informa; terminada a tentativa, ela vira
          histórico, e a decisão visual pede progresso compacto com detalhe
          recolhível. Deixá-la sempre aberta encheria a conversa de listas de
          quatro linhas a cada tentativa.
        */}
        {hasBuildSteps(lance.passos) ? <details className="dz-passos" open={lance.emCurso}>
          <summary>{ETAPA_LABEL[lance.etapa] ?? lance.etapa}</summary>
          <BuildSteps steps={lance.passos} finished={!lance.emCurso} />
        </details> : null}
      </div>
    </>
  }
  const bom = lance.estado === 'PASSED'
  return <>
    <p className="dz-lance-autor">{tarefa.estudioRespondeu}</p>
    <div className={classes('dz-bloco', 'dz-artefato', bom ? null : 'dz-artefato-atencao')}>
      <p className="dz-artefato-linha">
        {bom ? <CircleCheck aria-hidden="true" /> : lance.estado === 'CANCELLED' ? <CircleSlash aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
        <span>{tarefa.artefatoTitulo} · {tarefa.trabalhoTentativa} {lance.tentativa}</span>
      </p>
      {/*
        O ESTADO da tentativa, com todas as letras. Não há selo genérico aqui:
        "passou nas conferências desta tentativa" é o que se pode afirmar, e é
        diferente de "está pronto".
      */}
      <p className="dz-lance-texto">{rotuloDoEstado(lance.estado)}</p>
      <p className="dz-artefato-provas">
        <FileText aria-hidden="true" />
        {lance.evidencias.length === 0 ? tarefa.artefatoSemEvidencia : `${tarefa.artefatoEvidencias}: ${lance.evidencias.length}`}
      </p>
      <button type="button" className="dz-artefato-abrir"
        onClick={() => abrir({ tipo: 'artefato', runId: lance.runId })}>{tarefa.artefatoAbrir}</button>
    </div>
  </>
}
