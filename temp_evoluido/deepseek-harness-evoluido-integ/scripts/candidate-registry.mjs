/**
 * REGISTRO DE CANDIDATOS — decidir ANTES de instalar (EVO-01, fatia E0).
 *
 * O MASTER V6 §46 é explícito sobre onde esta decisão mora: "a seleção vira
 * registro no mecanismo existente de integração/ADR, não novo marketplace ou
 * banco de autoridade". Então este arquivo NÃO cria autoridade nenhuma. Ele
 * decide uma coisa só, e essa coisa é a que a AT-114 cobra: **um candidato
 * pode ser promovido a operacional?**
 *
 * Por que isso é código e não um documento: porque é uma decisão, e a lição que
 * esta árvore aprendeu mais de dez vezes é que se a decisão importa, ela não
 * mora na montagem — nem na prosa. Um documento dizendo "candidato incompatível
 * não é promovido" não impede ninguém de promover; uma função que recusa, com
 * teste que falha quando ela para de recusar, impede.
 *
 * O que este arquivo NÃO faz, de propósito: não instala, não baixa, não resolve
 * licença, não avalia compatibilidade e não pontua candidato. Ele lê o que foi
 * REGISTRADO e diz se aquilo sustenta uma promoção. Campo não verificado
 * permanece DESCONHECIDO — inventar pin, licença ou veredito é proibido pelo
 * §46, e é o defeito que este registro existe para não cometer.
 */

/**
 * As QUATRO decisões possíveis sobre um candidato (§46).
 *
 * Elas são quatro porque "adotar ou não adotar" esconde as duas saídas que mais
 * valem: aproveitar a IDEIA sem o código, e reimplementar um contrato pequeno.
 * Um registro que só oferecesse sim/não empurraria toda necessidade real para
 * uma instalação.
 */
export const DECISOES = [
  /** A ideia é boa e a implementação é nossa. Nada de terceiro entra. */
  'APROVEITAR_CONCEITO',
  /** Um componente limitado entra, com P37, licença resolvida e plano de saída. */
  'INTEGRAR_COMPONENTE',
  /** O contrato é pequeno o bastante para escrever, e a dependência não compensa. */
  'REIMPLEMENTAR_CONTRATO',
  /** Não entra. A capacidade continua rastreada pela alternativa que já existe. */
  'NAO_ADOTAR',
  /** Ainda não decidido: o estudo dirigido está aberto. NÃO é aprovação. */
  'EM_ESTUDO',
]

/**
 * O valor que um campo assume quando ninguém conferiu.
 *
 * Uma cadeia própria, e não `null` nem `''`: os dois se confundem com "não se
 * aplica" e com "vazio", e a diferença entre "não perguntei" e "perguntei e não
 * há" é justamente a que o §46 manda preservar.
 */
export const DESCONHECIDO = 'DESCONHECIDO'

/**
 * Os campos que uma PROMOÇÃO exige. Não é a lista de campos do registro: é a
 * lista do que precisa estar RESOLVIDO para o candidato virar operacional.
 *
 * Cada um está aqui porque a ausência dele já custou alguma coisa em algum
 * lugar, e o §46 nomeia todos.
 */
export const CAMPOS_DE_PROMOCAO = [
  'proprietario_repositorio', 'versao_avaliada', 'licenca', 'telemetria',
  'dados_enviados', 'custo', 'testes', 'plano_saida', 'autoridade_atual',
]

/** Os motivos de recusa, nomeados. Um "não" sem motivo não ensina nada. */
export const BLOQUEIOS = [
  /** Nome sem dono/repositório identificado. Não se instala por adivinhação. */
  'IDENTIDADE_NAO_RESOLVIDA',
  /** Licença por código, ativo e forma de uso não resolvida. */
  'LICENCA_NAO_RESOLVIDA',
  /** Manda dado para fora, e o perfil exigido não permite. */
  'TELEMETRIA_INCOMPATIVEL',
  /** Tem custo e ninguém aprovou o teto. */
  'CUSTO_NAO_APROVADO',
  /** Sem plano de retirada, entrar é decisão só de ida. */
  'SEM_PLANO_DE_SAIDA',
  /** Ninguém rodou nada contra ele. */
  'SEM_TESTES',
  /** Instalar não foi autorizado — e este pacote não autoriza (§02). */
  'INSTALACAO_NAO_AUTORIZADA',
  /** A decisão registrada não é de adoção. */
  'DECISAO_NAO_E_DE_ADOCAO',
  /** Campo exigido para promover ficou DESCONHECIDO. */
  'CAMPO_DESCONHECIDO',
]

/**
 * Os campos exigidos que ninguém conferiu.
 *
 * AUSENTE e DESCONHECIDO contam igual aqui — de propósito. Um campo que sumiu
 * do registro e um campo que ficou por conferir produzem a mesma ignorância, e
 * tratar a ausência como "não se aplica" seria exatamente o branco que o portão
 * do P37 já recusa desde que existe.
 * @param candidato - o registro.
 * @returns os nomes dos campos não resolvidos, na ordem da lista.
 */
export function desconhecidos(candidato) {
  return CAMPOS_DE_PROMOCAO.filter(campo => {
    const valor = candidato[campo]
    return valor === undefined || valor === null || valor === '' || valor === DESCONHECIDO
  })
}

/**
 * A capacidade continua rastreada depois de recusar o candidato?
 *
 * ESTA é a pergunta da AT-114, e ela é o contrário da intuição: o risco de um
 * registro de candidatos não é adotar demais, é a capacidade SUMIR junto com o
 * candidato recusado. "Não adotamos o Mitosis" vira, três meses depois,
 * "não fazemos componentes multi-formato" — e ninguém percebe a troca.
 *
 * Por isso todo candidato nomeia a CAPACIDADE que ele atenderia e a AUTORIDADE
 * que já a possui. Recusar o candidato não mexe em nenhuma das duas.
 * @param candidato - o registro.
 * @returns verdadeiro quando capacidade e autoridade continuam nomeadas.
 */
export function capacidadePreservada(candidato) {
  const capacidade = candidato.capacidade
  const autoridade = candidato.autoridade_atual
  return typeof capacidade === 'string' && capacidade.trim() !== ''
    && typeof autoridade === 'string' && autoridade.trim() !== '' && autoridade !== DESCONHECIDO
}

/**
 * Pode virar OPERACIONAL?
 *
 * Devolve TODOS os bloqueios, e não o primeiro: quem lê precisa saber o tamanho
 * do caminho, e uma recusa por vez faria alguém resolver a licença para
 * descobrir que faltava o plano de saída.
 *
 * `perfil` é o ambiente em que ele rodaria. `privado-local` é o perfil que não
 * deixa dado sair — e nele telemetria de terceiro é incompatível por definição,
 * não por gosto.
 * @param candidato - o registro.
 * @param opcoes - `perfil` em que a promoção está sendo pedida.
 * @returns `{ promovivel, bloqueios, capacidade_preservada }`.
 */
export function promocao(candidato, opcoes = {}) {
  const perfil = opcoes.perfil ?? 'privado-local'
  const bloqueios = []

  if (candidato.identidade_resolvida !== true) bloqueios.push('IDENTIDADE_NAO_RESOLVIDA')
  if (candidato.decisao !== 'INTEGRAR_COMPONENTE') bloqueios.push('DECISAO_NAO_E_DE_ADOCAO')
  if (candidato.licenca_aprovada !== true) bloqueios.push('LICENCA_NAO_RESOLVIDA')
  // A telemetria só bloqueia no perfil que não deixa dado sair. Num perfil que
  // permite saída, ela é um fato a declarar — e não um impedimento.
  if (perfil === 'privado-local' && candidato.telemetria_sai_da_maquina === true) bloqueios.push('TELEMETRIA_INCOMPATIVEL')
  if (candidato.custo_aprovado !== true) bloqueios.push('CUSTO_NAO_APROVADO')
  if (typeof candidato.plano_saida !== 'string' || candidato.plano_saida.trim() === '' || candidato.plano_saida === DESCONHECIDO) bloqueios.push('SEM_PLANO_DE_SAIDA')
  if (candidato.testes !== 'EXECUTADOS') bloqueios.push('SEM_TESTES')
  if (candidato.instalacao_autorizada !== true) bloqueios.push('INSTALACAO_NAO_AUTORIZADA')
  if (desconhecidos(candidato).length > 0) bloqueios.push('CAMPO_DESCONHECIDO')

  return {
    promovivel: bloqueios.length === 0,
    // Sem repetição e em ordem estável: dois registros com os mesmos problemas
    // produzem a mesma lista, e uma lista que balança não dá para comparar.
    bloqueios: BLOQUEIOS.filter(motivo => bloqueios.includes(motivo)),
    capacidade_preservada: capacidadePreservada(candidato),
  }
}

/**
 * Os problemas ESTRUTURAIS de um registro — o que o torna inconsultável.
 *
 * Diferente de `promocao`: aqui não se pergunta se o candidato serve, e sim se
 * o REGISTRO dele responde alguma coisa. Um registro sem capacidade nomeada não
 * é um candidato recusado; é um nome numa lista.
 * @param candidatos - todos os registros.
 * @returns as queixas, uma frase por problema.
 */
export function problemasDoRegistro(candidatos) {
  const problemas = []
  const vistos = new Set()
  for (const candidato of candidatos) {
    const id = candidato.id ?? '(sem id)'
    if (vistos.has(id)) problemas.push(`${id}: id repetido`)
    vistos.add(id)
    if (!DECISOES.includes(candidato.decisao)) problemas.push(`${id}: decisão "${String(candidato.decisao)}" não é uma das quatro`)
    if (!capacidadePreservada(candidato)) problemas.push(`${id}: recusar este candidato apagaria a capacidade — falta capacidade ou autoridade_atual`)
    // Um candidato marcado como operacional que não passa na promoção é a
    // contradição que este registro existe para impedir.
    if (candidato.estado === 'OPERACIONAL' && !promocao(candidato).promovivel) {
      problemas.push(`${id}: está OPERACIONAL e não sustenta promoção (${promocao(candidato).bloqueios.join(', ')})`)
    }
    if (candidato.identidade_resolvida !== true && candidato.decisao === 'INTEGRAR_COMPONENTE') {
      problemas.push(`${id}: decidido integrar sem identidade resolvida`)
    }
  }
  return problemas
}
