/**
 * PERFIS DE EXECUÇÃO E ALVOS DE ARTEFATO (EVO-06/07/08, fatia E2).
 *
 * O §49 abre com a instrução que decide este arquivo: "reutilizar o executor
 * atual e descrever perfis por capacidades". Nada de motor novo — o construtor
 * e a prévia continuam donos do que executam. O que faltava era **decidir**, e
 * decidir aqui significa três perguntas que hoje não tinham resposta
 * conferível:
 *
 * 1. onde esta tarefa roda, e o que acontece quando o lugar certo não existe;
 * 2. o que este produto REALMENTE suporta gerar, por etapa e por plataforma;
 * 3. quando uma atestação de compatibilidade deixa de valer.
 *
 * As três são a mesma doença em formas diferentes — ausência de prova virando
 * prova — e é por isso que moram juntas.
 */

/**
 * As etapas de um alvo, SEPARADAS de propósito (§49, AT-125).
 *
 * "Gera para celular" é uma frase que esconde cinco coisas. Produzir o código
 * é uma; compilá-lo é outra; executá-lo é outra; assiná-lo exige certificado; e
 * distribuí-lo exige conta de loja. Um produto que responde "suportado" para a
 * primeira e deixa a pessoa descobrir as outras quatro sozinha mentiu por
 * omissão — e é exatamente o que o §49 chama de "nenhuma imagem Docker genérica
 * garante build/assinatura em todas as plataformas".
 */
export const ETAPAS = ['fonte', 'build', 'execucao', 'assinatura', 'distribuicao'] as const
export type Etapa = typeof ETAPAS[number]

/**
 * O estado de UMA etapa.
 *
 * `NAO_SE_APLICA` não é um sim disfarçado: um alvo web não tem assinatura, e
 * responder `PRONTO` ali faria a contagem de etapas prontas subir por causa de
 * uma etapa que não existe.
 */
export const ESTADOS_DE_ETAPA = ['PROVADO', 'DECLARADO', 'INDISPONIVEL', 'NAO_SE_APLICA'] as const
export type EstadoDeEtapa = typeof ESTADOS_DE_ETAPA[number]

export interface Alvo {
  readonly id: string
  readonly etapas: Readonly<Record<Etapa, EstadoDeEtapa>>
  /** Por que a etapa indisponível está indisponível. */
  readonly motivo?: string
}

/**
 * Este alvo está PROVADO de ponta a ponta?
 *
 * Só quando toda etapa que se aplica está `PROVADO`. `DECLARADO` não conta —
 * essa é a distinção inteira: alguém escreveu que suporta, e ninguém rodou.
 * @param alvo - o alvo.
 * @returns verdadeiro só com prova em todas as etapas aplicáveis.
 */
export function alvoProvado(alvo: Alvo): boolean {
  return ETAPAS.every(etapa => alvo.etapas[etapa] === 'PROVADO' || alvo.etapas[etapa] === 'NAO_SE_APLICA')
}

/**
 * Um alvo INDISPONÍVEL derruba os outros?
 *
 * NUNCA. O §49 é explícito: "não exigir que todos os perfis existam em toda
 * instalação", e a AT-125 cobra que "bloqueio não é estendido a todo o Studio".
 * Esta função existe para que isso seja um fato conferível, e não uma intenção:
 * ela devolve os alvos que continuam utilizáveis mesmo com outro quebrado.
 * @param alvos - todos os alvos.
 * @returns os que têm ao menos a fonte e o build provados.
 */
export function alvosUtilizaveis(alvos: readonly Alvo[]): readonly Alvo[] {
  return alvos.filter(alvo => alvo.etapas.fonte === 'PROVADO' && alvo.etapas.build === 'PROVADO')
}

/** O que um perfil de execução sabe fazer. */
export interface Perfil {
  readonly id: string
  readonly capacidades: readonly string[]
  readonly disponivel: boolean
  /** O perfil é a MÁQUINA de quem opera? Um `host` nunca recebe queda automática. */
  readonly host: boolean
  readonly autorizado: boolean
}

export type EscolhaDePerfil =
  | { readonly estado: 'ESCOLHIDO'; readonly perfil: string }
  /** Nenhum perfil serve, e a tarefa PARA. Não há queda para o host. */
  | { readonly estado: 'BLOQUEADO'; readonly motivo: 'SEM_PERFIL_COMPATIVEL' | 'INDISPONIVEL' | 'NAO_AUTORIZADO' }

/**
 * Onde esta tarefa roda (EVO-06, AT-123).
 *
 * A regra que importa está na ausência: **não existe queda para o host.** Um
 * produto que, ao não encontrar o ambiente isolado, roda na máquina de quem
 * opera, trocou uma tarefa bloqueada por uma execução sem isolamento — e quem
 * pagou não foi avisado. Bloquear é a resposta certa, e ela é a única aqui.
 *
 * A ordem também importa: compatível primeiro, autorizado depois, disponível
 * por último. Os três motivos mandam fazer coisas diferentes — um pede outro
 * perfil, outro pede permissão, o terceiro pede esperar.
 * @param exigidas - as capacidades que a tarefa precisa.
 * @param perfis - os perfis conhecidos.
 * @returns o perfil escolhido, ou o bloqueio com o motivo.
 */
export function escolherPerfil(exigidas: readonly string[], perfis: readonly Perfil[]): EscolhaDePerfil {
  const compativeis = perfis.filter(perfil => exigidas.every(capacidade => perfil.capacidades.includes(capacidade)))
  if (compativeis.length === 0) return { estado: 'BLOQUEADO', motivo: 'SEM_PERFIL_COMPATIVEL' }
  const autorizados = compativeis.filter(perfil => perfil.autorizado)
  if (autorizados.length === 0) return { estado: 'BLOQUEADO', motivo: 'NAO_AUTORIZADO' }
  const disponiveis = autorizados.filter(perfil => perfil.disponivel)
  if (disponiveis.length === 0) return { estado: 'BLOQUEADO', motivo: 'INDISPONIVEL' }
  // O host só é escolhido quando ele é a ÚNICA opção compatível e autorizada, e
  // nunca como queda de um isolado que falhou. Preferir o não-host é o que
  // impede a queda silenciosa de acontecer por ordenação.
  const isolado = disponiveis.find(perfil => !perfil.host)
  return { estado: 'ESCOLHIDO', perfil: (isolado ?? disponiveis[0]!).id }
}

/**
 * O que uma atestação de compatibilidade cobre (EVO-08, AT-127).
 *
 * §50: "atestação de compatibilidade referencia versão do adapter/protocolo,
 * configuração, ambiente, conjunto de testes e limitações. Mudança material
 * invalida atestação pertinente."
 */
export interface Atestacao {
  readonly adaptador: string
  readonly versao: string
  readonly configuracao_sha256: string
  readonly ambiente: string
  /** Como foi provado. As três não são a mesma coisa. */
  readonly natureza: NaturezaDeProva
  readonly limitacoes: readonly string[]
}

/**
 * As três naturezas de prova, e elas NÃO se substituem (AT-127).
 *
 * "Distinguir declaração, contrato com fixtures e integração real" é a frase da
 * AT-127, e o motivo é que a mais barata é a que mais parece prova: um `ping`
 * que responde não diz nada sobre o que acontece quando a chamada é cancelada
 * no meio.
 */
export const NATUREZAS = ['DECLARADA', 'CONTRATO_COM_DOBRO', 'INTEGRACAO_REAL'] as const
export type NaturezaDeProva = typeof NATUREZAS[number]

export interface Ambiente { readonly nome: string; readonly configuracao_sha256: string; readonly versao: string }

export type ValidadeDaAtestacao =
  | { readonly valida: true }
  | { readonly valida: false; readonly motivo: 'VERSAO_MUDOU' | 'CONFIGURACAO_MUDOU' | 'OUTRO_AMBIENTE' }

/**
 * Esta atestação ainda vale AQUI?
 *
 * Três formas de deixar de valer, e cada uma com o próprio nome porque cada uma
 * pede uma ação diferente: subir a versão, reconferir a configuração, ou rodar
 * de novo no ambiente certo.
 *
 * A comparação é por igualdade, e não por "compatível": decidir que a versão
 * 3.9 herda a prova da 3.8 é a suposição que o §50 proíbe quando diz que
 * "mudança material invalida atestação pertinente" — e material é uma palavra
 * que quem quer reaproveitar a prova sempre consegue interpretar a seu favor.
 * @param atestacao - o que foi atestado.
 * @param ambiente - onde se quer usar a atestação agora.
 * @returns se vale, e por que não quando não vale.
 */
export function validadeDaAtestacao(atestacao: Atestacao, ambiente: Ambiente): ValidadeDaAtestacao {
  if (atestacao.ambiente !== ambiente.nome) return { valida: false, motivo: 'OUTRO_AMBIENTE' }
  if (atestacao.versao !== ambiente.versao) return { valida: false, motivo: 'VERSAO_MUDOU' }
  if (atestacao.configuracao_sha256 !== ambiente.configuracao_sha256) return { valida: false, motivo: 'CONFIGURACAO_MUDOU' }
  return { valida: true }
}

/**
 * Uma atestação DECLARADA autoriza efeito sensível?
 *
 * Não. §50: "remotos opacos que não oferecem prova do controle exigido não
 * recebem ferramentas de efeito nem o selo de isolamento local". Uma declaração
 * é o que o outro lado diz sobre si mesmo, e um adaptador que responde a um
 * `ping` pode ainda assim ignorar um cancelamento.
 * @param atestacao - o que foi atestado.
 * @returns verdadeiro só com contrato provado ou integração real.
 */
export function podeReceberEfeitoSensivel(atestacao: Atestacao): boolean {
  return atestacao.natureza === 'CONTRATO_COM_DOBRO' || atestacao.natureza === 'INTEGRACAO_REAL'
}

/** O desfecho de uma transição de ambiente (AT-124). */
export type Transicao =
  | { readonly estado: 'CONCLUIDA'; readonly dono: string }
  | { readonly estado: 'RECUSADA'; readonly motivo: 'HASH_NAO_CONFERE' | 'DONO_DUPLICADO' | 'CREDENCIAL_COPIADA' | 'EFEITO_ABERTO' }

export interface PedidoDeTransicao {
  readonly origem: string
  readonly destino: string
  readonly snapshot_sha256_origem: string
  readonly snapshot_sha256_destino: string
  /** Quem já é dono no destino. Vazio quando ninguém é. */
  readonly dono_no_destino?: string
  /** Referências de credencial que vieram junto. Copiar é recusado. */
  readonly credenciais_transportadas: readonly string[]
  /** Efeitos cujo desfecho ficou desconhecido. */
  readonly efeitos_desconhecidos: readonly string[]
}

/**
 * Transição entre ambientes (EVO-06, AT-124).
 *
 * Quatro recusas, e a ordem é a da gravidade do que aconteceria se ela passasse:
 *
 * 1. **hash não confere** — o que chegou não é o que saiu;
 * 2. **dono duplicado** — duas instâncias retomando a mesma operação é a
 *    execução dupla que o §49 proíbe, e ela cobra duas vezes;
 * 3. **credencial copiada** — o §49 diz "não copiar cookies/secrets"; uma
 *    credencial que viaja junto passa a existir em dois lugares, e revogá-la
 *    num não a revoga no outro;
 * 4. **efeito aberto** — `EFFECT_UNKNOWN` "continua sem retry automático"
 *    (§52). Um efeito cujo desfecho ninguém sabe não é repetido: ele é
 *    reconciliado, e isso é trabalho de quem tem autoridade, não da transição.
 * @param pedido - o que se quer mover.
 * @returns o desfecho, com o motivo nomeado quando recusa.
 */
export function transicao(pedido: PedidoDeTransicao): Transicao {
  if (pedido.snapshot_sha256_origem !== pedido.snapshot_sha256_destino) return { estado: 'RECUSADA', motivo: 'HASH_NAO_CONFERE' }
  if (pedido.dono_no_destino !== undefined && pedido.dono_no_destino !== '') return { estado: 'RECUSADA', motivo: 'DONO_DUPLICADO' }
  if (pedido.credenciais_transportadas.length > 0) return { estado: 'RECUSADA', motivo: 'CREDENCIAL_COPIADA' }
  if (pedido.efeitos_desconhecidos.length > 0) return { estado: 'RECUSADA', motivo: 'EFEITO_ABERTO' }
  return { estado: 'CONCLUIDA', dono: pedido.destino }
}
