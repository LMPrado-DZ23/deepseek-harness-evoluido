import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/**
 * A EMPRESA que o Studio opera, e o plano dela — versionado.
 *
 * `BUS-01` é a porta do Modo Empresa inteiro: sem empresa persistida não há
 * objetivo, oferta, pedido, entrega nem conciliação para pendurar em lugar
 * nenhum. Ela estava AUSENTE, junto com os outros vinte e três requisitos do
 * bloco, e é por ela que o bloco começa.
 *
 * ## O que ela NÃO é
 *
 * - **não é um inquilino novo.** A empresa mora DENTRO do escopo
 *   (`org_id`/`tenant_id`) que o Studio já isola. Criar uma autoridade de
 *   isolamento ao lado da que existe é o que a decisão do dono proíbe, e seria
 *   a segunda verdade mais cara que este repositório já produziu;
 * - **não é uma entidade jurídica.** CNPJ, contrato social e conta bancária
 *   são fatos do mundo, e o Studio não os cria nem os confere. O campo
 *   `identidade_juridica` guarda o que a PESSOA declarou, com essa palavra;
 * - **não é um projeto.** Um projeto é uma tarefa de criação; uma empresa
 *   tem objetivo, público e oferta e sobrevive a qualquer tarefa.
 *
 * ## Por que o plano é VERSIONADO
 *
 * Porque o aceite mínimo de `BUS-01` exige isso, e porque a razão é boa: o
 * plano muda, e uma decisão tomada sobre o plano de ontem precisa continuar
 * legível depois de o plano virar outro. Guardar só o plano atual apagaria a
 * pergunta "com base em quê nós decidimos isso?".
 */

/** O plano de negócio de UMA versão. Ele nunca é editado no lugar. */
export const planoDeNegocioSchema = z.object({
  /** O que a empresa se propõe a fazer. */
  objetivo: z.string().min(10).max(2_000),
  /** Para quem. */
  publico: z.string().min(3).max(500),
  /** O que ela entrega. Vazio é um estado honesto: ainda não foi decidido. */
  oferta: z.string().max(2_000),
  /**
   * Os limites que a pessoa declarou — o que a empresa NÃO faz, o que exige
   * decisão dela, o que está fora do orçamento.
   *
   * É uma lista e não um texto porque cada limite é conferido sozinho depois,
   * e um parágrafo com cinco limites dentro não é conferível.
   */
  limites: z.array(z.string().min(3).max(300)).max(20),
}).strict()

export type PlanoDeNegocio = z.infer<typeof planoDeNegocioSchema>

export const registroDePlanoSchema = z.object({
  plan_id: z.string().min(1),
  business_id: z.string().min(1),
  org_id: z.string().min(1),
  tenant_id: z.string().min(1),
  /** 1 na primeira, e sempre a anterior mais um. */
  version: z.number().int().positive(),
  plano: planoDeNegocioSchema,
  /** Quem escreveu esta versão. */
  created_by: z.string().min(1),
  created_at: z.iso.datetime(),
}).strict()

export type RegistroDePlano = z.infer<typeof registroDePlanoSchema>

export const empresaSchema = z.object({
  business_id: z.string().min(1),
  org_id: z.string().min(1),
  tenant_id: z.string().min(1),
  nome: z.string().min(2).max(120),
  /**
   * Como a empresa entrou: CRIADA aqui, ou VINCULADA a uma que já existe no
   * mundo. A diferença não é cosmética — uma empresa vinculada tem fatos que o
   * Studio não produziu e não pode alterar.
   */
  origem: z.enum(['criada', 'vinculada']),
  /**
   * O que a PESSOA declarou sobre a identidade jurídica. `null` é a resposta
   * honesta enquanto ela não declarou nada.
   *
   * O Studio NÃO confere este campo contra registro nenhum. Ele guarda a
   * declaração, e a palavra "declarada" está no nome para que ninguém leia
   * isto como verificação.
   */
  identidade_juridica_declarada: z.string().max(200).nullable(),
  created_by: z.string().min(1),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  /** Arquivada some das listas e não pode receber plano novo. */
  archived_at: z.iso.datetime().nullable(),
}).strict()

export type Empresa = z.infer<typeof empresaSchema>

declare const businessKeyBrand: unique symbol
export type BusinessKey = string & { readonly [businessKeyBrand]: true }

/**
 * O VÍNCULO entre uma tarefa e a empresa para a qual ela foi criada.
 *
 * Ele é um registro próprio, e não um campo dentro da tarefa, por uma razão de
 * autoridade: a tarefa é do `prompt-to-app`, que não conhece — e não deve
 * conhecer — o Modo Empresa. Um campo lá dentro faria o dono do projeto passar
 * a carregar um conceito que não é dele, e faria a versão daquele domínio
 * depender deste.
 *
 * `plan_version` é gravado JUNTO de propósito: a tarefa foi criada com o plano
 * de HOJE, e quando ele virar a versão 5 a pergunta "com base em quê esta
 * tarefa foi feita?" ainda tem resposta. Guardar só o `business_id` apagaria
 * essa pergunta na primeira revisão do plano.
 */
export const vinculoDeTarefaSchema = z.object({
  link_id: z.string().min(1),
  business_id: z.string().min(1),
  project_id: z.string().min(1),
  org_id: z.string().min(1),
  tenant_id: z.string().min(1),
  /** A versão do plano que valia quando a tarefa nasceu. */
  plan_version: z.number().int().positive(),
  created_by: z.string().min(1),
  created_at: z.iso.datetime(),
}).strict()

export type VinculoDeTarefa = z.infer<typeof vinculoDeTarefaSchema>

/**
 * Um CUSTO declarado da oferta.
 *
 * `valor` é anulável de propósito, e essa é a parte que o aceite de `BUS-03`
 * exige: "margem estimada declara custos ausentes". Um custo que a pessoa sabe
 * existir e não sabe quanto é — frete, taxa da maquininha, hora de alguém — é
 * um fato diferente de "não há esse custo". Forçá-la a escrever zero faria a
 * margem mentir para cima, e é exatamente a mentira que a regra proíbe.
 */
export const custoSchema = z.object({
  nome: z.string().min(2).max(120),
  /** `null` quando a pessoa declarou o custo e ainda não sabe o valor. */
  valor: z.number().nonnegative().nullable(),
}).strict()

export type Custo = z.infer<typeof custoSchema>

/** A capacidade de entrega: quanto, em quanto tempo. */
export const capacidadeSchema = z.object({
  quantidade: z.number().int().nonnegative(),
  periodo: z.enum(['dia', 'semana', 'mes']),
}).strict()

export type Capacidade = z.infer<typeof capacidadeSchema>

/**
 * A OFERTA de UMA versão. Ela nunca é editada no lugar.
 *
 * Os campos são os do aceite mínimo de `BUS-03`, um a um: entrega, público,
 * preço e moeda, capacidade e condições. `preco` é anulável porque um rascunho
 * sem preço é um estado legítimo do trabalho — o que não é legítimo é aprovar
 * sem ele, e quem recusa isso é `recusaDeAprovacao`.
 */
export const ofertaSchema = z.object({
  nome: z.string().min(2).max(120),
  /** O que a empresa entrega. */
  entrega: z.string().min(10).max(2_000),
  /** Para quem. */
  publico: z.string().min(3).max(500),
  /** Quanto custa para quem compra. `null` enquanto ninguém decidiu. */
  preco: z.number().positive().nullable(),
  /**
   * A moeda, em ISO 4217. É OBRIGATÓRIA mesmo sem preço: um número sem moeda é
   * ambíguo no primeiro dia em que alguém vender para fora do país, e um padrão
   * silencioso é a segunda verdade que só aparece quando já custou dinheiro.
   */
  moeda: z.string().length(3).regex(/^[A-Z]{3}$/u),
  capacidade: capacidadeSchema,
  /**
   * As condições — prazo, garantia, o que não está incluído.
   *
   * Lista, e não parágrafo, pela mesma razão dos limites do plano: cada
   * condição é conferida sozinha depois, e um texto com cinco condições dentro
   * não é conferível.
   */
  condicoes: z.array(z.string().min(3).max(300)).max(30),
  /** Os custos declarados, que a margem usa e cuja ausência ela declara. */
  custos: z.array(custoSchema).max(30),
}).strict()

export type Oferta = z.infer<typeof ofertaSchema>

export const registroDeOfertaSchema = z.object({
  offer_version_id: z.string().min(1),
  /**
   * Qual oferta do catálogo é esta. Ela sobrevive às revisões: renomear a
   * oferta na versão 4 não a transforma em outra oferta, e é por isso que a
   * identidade não é o nome.
   */
  offer_key: z.string().min(1),
  business_id: z.string().min(1),
  org_id: z.string().min(1),
  tenant_id: z.string().min(1),
  /** 1 na primeira, e sempre a anterior mais um, POR OFERTA. */
  version: z.number().int().positive(),
  oferta: ofertaSchema,
  created_by: z.string().min(1),
  created_at: z.iso.datetime(),
  /**
   * Quando esta versão foi APROVADA, e por quem. `null` é rascunho.
   *
   * A aprovação fica na VERSÃO, e não na oferta, porque é isso que "condições
   * aprovadas" quer dizer: as condições que estavam escritas quando alguém
   * aprovou. Guardar a aprovação na oferta faria uma revisão posterior herdar
   * a aprovação de um texto que ninguém leu.
   */
  approved_at: z.iso.datetime().nullable(),
  approved_by: z.string().min(1).nullable(),
}).strict()

export type RegistroDeOferta = z.infer<typeof registroDeOfertaSchema>

export const STUDIO_BUSINESS_DOMAIN = 'studio_businesses'
export const STUDIO_BUSINESS_PLANS_DOMAIN = 'studio_business_plans'
export const STUDIO_BUSINESS_TASKS_DOMAIN = 'studio_business_tasks'
export const STUDIO_BUSINESS_OFFERS_DOMAIN = 'studio_business_offers'

export const studioBusinessDomainSpec = defineDomain({
  name: STUDIO_BUSINESS_DOMAIN,
  // Nasce em 1 e fica em 1, como os outros: `open()` falha com
  // `version-mismatch` em instalação que já rodou e não existe passo de
  // migração neste seam. Campo novo entra OPCIONAL.
  version: 1,
  tables: { businesses: domainTable<BusinessKey, Empresa>(empresaSchema) },
})

export const studioBusinessPlansDomainSpec = defineDomain({
  name: STUDIO_BUSINESS_PLANS_DOMAIN,
  version: 1,
  tables: { plans: domainTable<BusinessKey, RegistroDePlano>(registroDePlanoSchema) },
})

export const studioBusinessTasksDomainSpec = defineDomain({
  name: STUDIO_BUSINESS_TASKS_DOMAIN,
  version: 1,
  tables: { links: domainTable<BusinessKey, VinculoDeTarefa>(vinculoDeTarefaSchema) },
})

export const studioBusinessOffersDomainSpec = defineDomain({
  name: STUDIO_BUSINESS_OFFERS_DOMAIN,
  version: 1,
  tables: { offers: domainTable<BusinessKey, RegistroDeOferta>(registroDeOfertaSchema) },
})

export const BUSINESS_DOMAIN_SPECS = [
  studioBusinessDomainSpec,
  studioBusinessPlansDomainSpec,
  studioBusinessTasksDomainSpec,
  studioBusinessOffersDomainSpec,
] as const
