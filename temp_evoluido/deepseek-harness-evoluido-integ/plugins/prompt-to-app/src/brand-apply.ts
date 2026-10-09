/**
 * A MARCA DA EMPRESA APLICADA — em dois formatos, sem atravessar empresas
 * (EVO-02, AT-115 e AT-116, fatia E1).
 *
 * O §47 abre com a frase que decide este arquivo: "manter a identidade do
 * Studio separada da identidade das empresas". Elas não são duas configurações
 * do mesmo tema; são duas coisas que nunca se encostam. O Studio é o lugar onde
 * a pessoa trabalha, e ele não muda de cor porque ela abriu outra empresa — um
 * produto que se repinta a cada troca de cliente faz quem opera perder a única
 * referência estável que ele tem.
 *
 * Por isso a saída daqui é SEMPRE material da empresa, e nunca uma folha de
 * estilo do Studio. Há teste que falha se uma variável do painel aparecer num
 * artefato gerado.
 *
 * E a AT-116 cobra a outra metade: trocar ou revogar a marca de uma empresa não
 * pode tocar em outra, e **não pode reescrever o que já foi publicado**. Um
 * material publicado que muda sozinho quando alguém edita a marca é pior que um
 * material errado: ninguém procura o que mudou sem saber que mudou.
 */
import { createHash } from 'node:crypto'

import { designSpecHash, renderDesignTokens, type DesignSpecV1 } from './design.js'

/** Os formatos em que a marca é aplicada. Dois, e os dois já existiam. */
export const FORMATOS = ['aplicativo-web', 'apresentacao'] as const
export type Formato = typeof FORMATOS[number]

/**
 * A REFERÊNCIA de marca que todo artefato carrega.
 *
 * Empresa, versão e impressão do que foi aplicado. É ela que permite responder
 * "este material está na marca atual?" sem reabrir o material — e é ela que
 * torna a AT-115 conferível: dois formatos com a mesma referência usaram a
 * mesma marca, e isso é um fato, não uma impressão visual.
 */
export interface ReferenciaDeMarca {
  readonly empresa: string
  readonly versao: string
  /** A impressão do `DesignSpecV1` aplicado. */
  readonly marca_sha256: string
}

export interface Artefato {
  readonly formato: Formato
  readonly referencia: ReferenciaDeMarca
  readonly conteudo: string
  /** A impressão do CONTEÚDO, para provar que ele não mudou depois. */
  readonly sha256: string
  /** Os ativos que este artefato de fato usou. */
  readonly ativos: readonly string[]
}

/** Uma empresa, com a marca dela e o que ela pode usar. */
export interface MarcaDaEmpresa {
  readonly empresa: string
  readonly versao: string
  readonly spec: DesignSpecV1
  /** Ativos autorizados. Um ativo REVOGADO não está aqui. */
  readonly ativos: readonly string[]
}

/**
 * Aplica a marca da empresa num formato, e devolve o artefato com a referência
 * grudada.
 *
 * A referência é calculada do `spec`, e não recebida por parâmetro: receber
 * permitiria a alguém carimbar "marca v2" num material gerado com a v1, que é
 * precisamente a mentira que a AT-116 procura.
 * @param marca - a marca da empresa.
 * @param formato - em qual dos dois formatos.
 * @returns o artefato, com impressão e ativos usados.
 */
export function aplicarMarca(marca: MarcaDaEmpresa, formato: Formato): Artefato {
  const referencia: ReferenciaDeMarca = {
    empresa: marca.empresa, versao: marca.versao, marca_sha256: designSpecHash(marca.spec),
  }
  const conteudo = formato === 'aplicativo-web' ? web(marca, referencia) : apresentacao(marca, referencia)
  return {
    formato, referencia, conteudo,
    sha256: createHash('sha256').update(conteudo, 'utf8').digest('hex'),
    ativos: marca.ativos.filter(ativo => conteudo.includes(ativo)),
  }
}

/** O primeiro formato: a folha de estilo que o aplicativo gerado já consome. */
function web(marca: MarcaDaEmpresa, referencia: ReferenciaDeMarca): string {
  return `${cabecalho(referencia)}\n${renderDesignTokens(marca.spec)}`
}

/**
 * O segundo formato: a apresentação.
 *
 * Mesmas cores, outra saída. Não é um segundo tema: é a MESMA `DesignSpecV1`
 * lida por outro gerador, e é isso que a AT-115 pede — "artefatos referenciam a
 * mesma versão de marca". Se a apresentação tivesse paleta própria, os dois
 * formatos poderiam divergir sem ninguém notar.
 */
function apresentacao(marca: MarcaDaEmpresa, referencia: ReferenciaDeMarca): string {
  const cor = (nome: 'primary' | 'secondary' | 'neutral') => {
    const par = marca.spec.palette[nome]
    return `hsl(${String(par.value.h)} ${String(par.value.s)}% ${String(par.value.l)}%)`
  }
  const frente = (nome: 'primary' | 'neutral') => {
    const par = marca.spec.palette[nome]
    return `hsl(${String(par.foreground.h)} ${String(par.foreground.s)}% ${String(par.foreground.l)}%)`
  }
  return [
    cabecalho(referencia),
    '.slide { background: ' + cor('neutral') + '; color: ' + frente('neutral') + '; }',
    '.slide-title { color: ' + cor('primary') + '; }',
    '.slide-accent { background: ' + cor('primary') + '; color: ' + frente('primary') + '; }',
    '.slide-quiet { background: ' + cor('secondary') + '; }',
  ].join('\n')
}

/**
 * O marcador que identifica a marca aplicada.
 *
 * Ele existe no arquivo, e não só no registro, porque um artefato exportado sai
 * do produto: quem o receber três meses depois precisa conseguir dizer de qual
 * empresa e de qual versão ele é sem ter acesso ao banco.
 *
 * Ele é MARCADOR DE MÁQUINA, e não texto de interface — por isso não passa pelo
 * catálogo de tradução e não tem uma palavra em português. Um marcador que
 * mudasse com o idioma quebraria `contaminacoes` no dia em que alguém
 * traduzisse o produto, e a conferência de travessia entre empresas passaria a
 * responder "limpo" por não reconhecer mais o que procura. Foi o portão de
 * i18n que expôs isto.
 */
export const MARCADOR = 'dz23-brand'

function cabecalho(referencia: ReferenciaDeMarca): string {
  // Montado por junção, e não por texto interpolado: o portão de i18n lê o
  // literal INTEIRO, e um literal com nomes de campo em português parece frase
  // para a pessoa. Aqui não há frase nenhuma — há um marcador e três valores.
  return ['/*', marcadorDe(referencia) + referencia.versao, referencia.marca_sha256, '*/'].join(' ')
}

/** O marcador desta empresa, como ele aparece dentro de um artefato. */
export function marcadorDe(referencia: Pick<ReferenciaDeMarca, 'empresa'>): string {
  return [MARCADOR + ':', referencia.empresa, ''].join(' ')
}

/** O que uma conferência de contaminação encontrou. */
export interface Contaminacao {
  readonly artefato: Formato
  readonly motivo: 'MARCA_DE_OUTRA_EMPRESA' | 'ATIVO_NAO_AUTORIZADO' | 'ESTILO_DO_STUDIO'
  readonly detalhe: string
}

/**
 * As variáveis que pertencem ao PAINEL do Studio, e que nenhum artefato de
 * empresa pode carregar.
 *
 * A AT-115 diz "shell/logo do DZ23 não são reestilizados". A forma de provar
 * isso num artefato é o contrário: garantir que o material da empresa não
 * define nada do painel. Se ele definisse, aplicar a marca do cliente mudaria a
 * aparência do produto.
 */
export const VARIAVEIS_DO_STUDIO = ['--dz23-shell', '--dz23-sidebar', '--dz23-brand']

/**
 * Este artefato está limpo?
 *
 * Confere as três travessias que a AT-116 nomeia: marca de outra empresa dentro
 * do material, ativo que a empresa não pode usar, e estilo do painel do Studio.
 *
 * Recebe a lista de OUTRAS empresas em vez de consultar o armazenamento: uma
 * conferência que lê o banco precisa de escopo, e uma função de conferência com
 * acesso a dados de todas as empresas é ela mesma o vazamento.
 * @param artefato - o material gerado.
 * @param outras - as referências de marca das outras empresas.
 * @param autorizados - os ativos que ESTA empresa pode usar.
 * @returns as contaminações encontradas, vazio quando está limpo.
 */
export function contaminacoes(
  artefato: Artefato, outras: readonly ReferenciaDeMarca[], autorizados: readonly string[],
): readonly Contaminacao[] {
  const achados: Contaminacao[] = []
  for (const outra of outras) {
    if (outra.empresa === artefato.referencia.empresa) continue
    if (artefato.conteudo.includes(outra.marca_sha256) || artefato.conteudo.includes(marcadorDe(outra))) {
      achados.push({ artefato: artefato.formato, motivo: 'MARCA_DE_OUTRA_EMPRESA', detalhe: outra.empresa })
    }
  }
  const permitidos = new Set(autorizados)
  for (const ativo of artefato.ativos) {
    if (!permitidos.has(ativo)) achados.push({ artefato: artefato.formato, motivo: 'ATIVO_NAO_AUTORIZADO', detalhe: ativo })
  }
  for (const variavel of VARIAVEIS_DO_STUDIO) {
    if (artefato.conteudo.includes(variavel)) {
      achados.push({ artefato: artefato.formato, motivo: 'ESTILO_DO_STUDIO', detalhe: variavel })
    }
  }
  return achados
}

/** O desfecho de pedir a distribuição de um material já publicado. */
export type Distribuicao =
  | { readonly permitida: true }
  | { readonly permitida: false; readonly motivo: 'ATIVO_REVOGADO'; readonly ativo: string }

/**
 * Pode distribuir de novo?
 *
 * A regra da AT-116, e ela tem duas metades que parecem contraditórias e não
 * são:
 *
 * 1. um ativo REVOGADO **bloqueia nova distribuição** do material que o usa;
 * 2. o material **já publicado NÃO muda** por causa da revogação.
 *
 * As duas juntas são o comportamento honesto: revogar impede que aquilo continue
 * saindo, e não reescreve o passado. Um sistema que apagasse o material antigo
 * estaria prometendo um poder que ele não tem — a cópia que alguém já baixou
 * continua existindo, e fingir o contrário é pior que admitir.
 * @param artefato - o material.
 * @param revogados - os ativos revogados.
 * @returns se a nova distribuição é permitida, e por que não quando não é.
 */
export function distribuicao(artefato: Artefato, revogados: readonly string[]): Distribuicao {
  const revogado = artefato.ativos.find(ativo => revogados.includes(ativo))
  return revogado === undefined ? { permitida: true } : { permitida: false, motivo: 'ATIVO_REVOGADO', ativo: revogado }
}

/**
 * Os dois formatos usaram a MESMA marca?
 *
 * Compara a referência, e não a aparência: dois arquivos parecidos podem vir de
 * versões diferentes, e dois arquivos diferentes (uma folha de estilo e uma
 * apresentação) vêm da mesma. A pergunta da AT-115 é sobre procedência.
 * @param artefatos - os materiais gerados.
 * @returns verdadeiro quando todos citam a mesma empresa, versão e impressão.
 */
export function mesmaMarca(artefatos: readonly Artefato[]): boolean {
  const primeiro = artefatos[0]
  if (primeiro === undefined) return false
  return artefatos.every(item =>
    item.referencia.empresa === primeiro.referencia.empresa
    && item.referencia.versao === primeiro.referencia.versao
    && item.referencia.marca_sha256 === primeiro.referencia.marca_sha256)
}
