/**
 * O cliente HTTP das empresas.
 *
 * Ele NÃO abre um segundo cliente ao lado do que já existe: a forma de chamar
 * (cookie de mesma origem, cabeçalho CSRF na escrita, erro tipado com a frase
 * do modo sem rede) vem inteira de `hubApi`, porque duas descrições da mesma
 * regra divergem no primeiro conserto de uma delas. O que é próprio daqui são
 * os endereços e os formatos.
 *
 * As rotas moram sob `/api/studio/apps` porque é lá que o Modo Empresa se
 * registra: o núcleo do prompt-to-app continua sendo quem autentica, confere o
 * CSRF e resolve o papel. Nenhuma autoridade nova.
 */
import pwa from '../i18n/pwa.pt-BR.json'
import { APPS_API_PREFIX, HubApiError, csrfFromCookie, type HubTransport } from '../hub/hubApi'

export interface Empresa {
  readonly business_id: string
  readonly org_id: string
  readonly tenant_id: string
  readonly nome: string
  readonly origem: 'criada' | 'vinculada'
  readonly identidade_juridica_declarada: string | null
  readonly created_by: string
  readonly created_at: string
  readonly updated_at: string
  readonly archived_at: string | null
}

export interface PlanoDeNegocio {
  readonly objetivo: string
  readonly publico: string
  readonly oferta: string
  readonly limites: readonly string[]
}

export interface RegistroDePlano {
  readonly plan_id: string
  readonly business_id: string
  readonly version: number
  readonly plano: PlanoDeNegocio
  readonly created_by: string
  readonly created_at: string
}

export interface NovaEmpresa {
  readonly nome: string
  readonly origem: 'criada' | 'vinculada'
  readonly identidade_juridica_declarada: string | null
  readonly plano: PlanoDeNegocio
}

const transporteDoNavegador: HubTransport = {
  fetch: (input, init) => fetch(input, init),
  cookie: () => (typeof document === 'undefined' ? '' : document.cookie),
}

export function createEmpresaApi(transport: HubTransport = transporteDoNavegador) {
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const escrita = init.method !== undefined && init.method !== 'GET'
    const headers: Record<string, string> = escrita
      ? { 'content-type': 'application/json', 'x-dz23-csrf': csrfFromCookie(transport.cookie()) }
      : {}
    const response = await transport.fetch(`${APPS_API_PREFIX}${path}`, { ...init, credentials: 'same-origin', headers })
    let body: (T & { error?: string; offline?: boolean }) | undefined
    try { body = await response.json() as T & { error?: string; offline?: boolean } } catch { body = undefined }
    if (!response.ok) {
      // Um código de estado cru nunca chega a uma pessoa: cada recusa vira uma
      // frase, e a do modo sem rede é a mesma do resto do produto.
      if (body?.offline === true || body?.error === 'OFFLINE') throw new HubApiError(response.status, pwa.offline.blockedAction, true)
      if (body?.error === 'SERVICE_UNREACHABLE') throw new HubApiError(response.status, pwa.offline.serviceUnreachable, false)
      throw new HubApiError(response.status, body?.error ?? `HTTP ${response.status}`, false)
    }
    return body as T
  }
  return {
    empresas: () => call<{ businesses: Empresa[] }>('/businesses').then(valor => valor.businesses),
    empresa: (businessId: string) => call<{ business: Empresa; plans: RegistroDePlano[] }>(`/businesses/${encodeURIComponent(businessId)}`),
    criar: (entrada: NovaEmpresa) => call<{ business: Empresa; plan: RegistroDePlano }>('/businesses', { method: 'POST', body: JSON.stringify(entrada) }),
    revisarPlano: (businessId: string, plano: PlanoDeNegocio) =>
      call<{ plan: RegistroDePlano }>(`/businesses/${encodeURIComponent(businessId)}/plan`, { method: 'POST', body: JSON.stringify({ plano }) }).then(valor => valor.plan),
    arquivar: (businessId: string) =>
      call<{ business: Empresa }>(`/businesses/${encodeURIComponent(businessId)}/archive`, { method: 'POST', body: '{}' }).then(valor => valor.business),
  }
}

export type EmpresaApi = ReturnType<typeof createEmpresaApi>

/** O endereço da tela de empresas. */
export const EMPRESA_PATH = '/studio/empresas'

/**
 * Se um endereço é o da tela de empresas.
 * @param pathname - o caminho atual do navegador.
 * @returns `true` quando a tela de empresas deve abrir.
 */
export function isEmpresaPath(pathname: string): boolean {
  return pathname === EMPRESA_PATH || pathname.startsWith(`${EMPRESA_PATH}/`)
}
