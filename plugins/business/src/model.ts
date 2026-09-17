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

export const STUDIO_BUSINESS_DOMAIN = 'studio_businesses'
export const STUDIO_BUSINESS_PLANS_DOMAIN = 'studio_business_plans'
export const STUDIO_BUSINESS_TASKS_DOMAIN = 'studio_business_tasks'

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

export const BUSINESS_DOMAIN_SPECS = [
  studioBusinessDomainSpec,
  studioBusinessPlansDomainSpec,
  studioBusinessTasksDomainSpec,
] as const
