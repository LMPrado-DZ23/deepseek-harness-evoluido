import { readFileSync } from 'node:fs'

export interface GeneratedAppCatalog {
  readonly common: {
    readonly loading: string
    readonly save: string
    readonly add: string
    readonly saveChanges: string
    readonly saving: string
    readonly cancel: string
    readonly close: string
    readonly edit: string
    readonly delete: string
    readonly confirmDelete: string
    readonly confirmDeleteAction: string
    readonly emptyState: string
    readonly requiredField: string
    readonly invalidValue: string
    readonly tryAgain: string
    readonly success: string
    readonly unexpectedError: string
    readonly manageEntity: string
    readonly newRecord: string
    readonly records: string
    readonly savedRecords: string
    readonly managementArea: string
    readonly managementSignIn: string
    readonly yes: string
    readonly no: string
    readonly select: string
  }
  readonly auth: {
    readonly title: string
    readonly codeLabel: string
    readonly codePlaceholder: string
    readonly submit: string
    readonly submitting: string
    readonly signOut: string
    readonly invalidCode: string
    readonly expiredCode: string
    readonly expiredSession: string
    readonly emailLabel: string
    readonly codeSixLabel: string
    readonly accessHeading: string
    readonly accessStatus: string
    readonly inviteByEmail: string
    readonly requestCode: string
    readonly sendInvite: string
    readonly lockedCode: string
    readonly invalidSession: string
    readonly revokedSession: string
    readonly csrfMissing: string
    readonly ownerInviteOnly: string
    readonly invitationRequired: string
    readonly invalidEmail: string
    readonly mailCodeSubject: string
    readonly mailCodeBody: string
    readonly mailInviteSubject: string
    readonly mailInviteBody: string
  }
  readonly validation: {
    readonly requireOneField: string
  }
  readonly reference: {
    readonly label: string
    readonly choose: string
    readonly none: string
    readonly loading: string
    readonly required: string
    readonly invalid: string
    readonly targetMissing: string
    readonly inUse: string
  }
  readonly scheduling: {
    readonly title: string
    readonly dateLabel: string
    readonly timeLabel: string
    readonly statusLabel: string
    readonly statusPending: string
    readonly statusConfirmed: string
    readonly statusCancelled: string
    readonly create: string
    readonly confirm: string
    readonly emptyState: string
    readonly conflict: string
    readonly invalidDate: string
    readonly pastDate: string
    readonly invalidTransition: string
  }
  readonly dashboard: {
    readonly title: string
    readonly summary: string
    readonly records: string
    readonly total: string
    readonly emptyState: string
    readonly refresh: string
    readonly tableLabel: string
    readonly chartLabel: string
    readonly notInformed: string
    readonly dateNotInformed: string
    readonly groupBy: string
    readonly groupCaption: string
    readonly count: string
    readonly recordSingular: string
    readonly recordPlural: string
    readonly totalSuffix: string
    readonly months: string
    readonly monthOfYear: string
  }
  readonly saas: {
    readonly title: string
    readonly workspaceLabel: string
    readonly members: string
    readonly memberEmail: string
    readonly invite: string
    readonly remove: string
    readonly roleOwner: string
    readonly roleMember: string
    readonly ownerOnly: string
    readonly forbidden: string
    readonly notFound: string
    readonly isolationError: string
  }
  readonly smtp: {
    readonly deliveryTitle: string
    readonly deliveryDescription: string
    readonly configured: string
    readonly notConfigured: string
    readonly send: string
    readonly resend: string
    readonly sent: string
    readonly failure: string
  }
}

const REQUIRED_KEYS = {
  common: ['loading', 'save', 'add', 'saveChanges', 'saving', 'cancel', 'close', 'edit', 'delete', 'confirmDelete', 'confirmDeleteAction', 'emptyState', 'requiredField', 'invalidValue', 'tryAgain', 'success', 'unexpectedError', 'manageEntity', 'newRecord', 'records', 'savedRecords', 'managementArea', 'managementSignIn', 'yes', 'no', 'select'],
  auth: ['title', 'codeLabel', 'codePlaceholder', 'submit', 'submitting', 'signOut', 'invalidCode', 'expiredCode', 'expiredSession', 'emailLabel', 'codeSixLabel', 'accessHeading', 'accessStatus', 'inviteByEmail', 'requestCode', 'sendInvite', 'lockedCode', 'invalidSession', 'revokedSession', 'csrfMissing', 'ownerInviteOnly', 'invitationRequired', 'invalidEmail', 'mailCodeSubject', 'mailCodeBody', 'mailInviteSubject', 'mailInviteBody'],
  validation: ['requireOneField'],
  reference: ['label', 'choose', 'none', 'loading', 'required', 'invalid', 'targetMissing', 'inUse'],
  scheduling: ['title', 'dateLabel', 'timeLabel', 'statusLabel', 'statusPending', 'statusConfirmed', 'statusCancelled', 'create', 'confirm', 'emptyState', 'conflict', 'invalidDate', 'pastDate', 'invalidTransition'],
  dashboard: ['title', 'summary', 'records', 'total', 'emptyState', 'refresh', 'tableLabel', 'chartLabel', 'notInformed', 'dateNotInformed', 'groupBy', 'groupCaption', 'count', 'recordSingular', 'recordPlural', 'totalSuffix', 'months', 'monthOfYear'],
  saas: ['title', 'workspaceLabel', 'members', 'memberEmail', 'invite', 'remove', 'roleOwner', 'roleMember', 'ownerOnly', 'forbidden', 'notFound', 'isolationError'],
  smtp: ['deliveryTitle', 'deliveryDescription', 'configured', 'notConfigured', 'send', 'resend', 'sent', 'failure'],
} as const satisfies Readonly<Record<keyof GeneratedAppCatalog, readonly string[]>>

type RequiredKeys = typeof REQUIRED_KEYS
export type GeneratedAppTranslationKey = {
  [Namespace in keyof RequiredKeys]: `${Namespace & string}.${RequiredKeys[Namespace][number] & string}`
}[keyof RequiredKeys]

export type GeneratedAppInterpolationValue = string | number | boolean
export type GeneratedAppInterpolation = Readonly<Record<string, GeneratedAppInterpolationValue>>

type GeneratedAppI18nErrorCode =
  | 'CATALOG_READ_FAILED'
  | 'CATALOG_INVALID_JSON'
  | 'CATALOG_INVALID_SHAPE'
  | 'CATALOG_UNKNOWN_KEY'
  | 'CATALOG_MISSING_KEY'
  | 'CATALOG_EMPTY_VALUE'
  | 'CATALOG_INVALID_PLACEHOLDER'
  | 'TRANSLATION_MISSING'
  | 'INTERPOLATION_MISSING'
  | 'INTERPOLATION_UNKNOWN'

export class GeneratedAppI18nError extends Error {
  constructor(
    readonly code: GeneratedAppI18nErrorCode,
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(`${code}:${detail}`, options)
    this.name = 'GeneratedAppI18nError'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

function placeholders(template: string, key: string): ReadonlySet<string> {
  const names = new Set<string>()
  const withoutValid = template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/gu, (_match, name: string) => {
    names.add(name)
    return ''
  })
  if (/[{}]/u.test(withoutValid)) {
    throw new GeneratedAppI18nError('CATALOG_INVALID_PLACEHOLDER', key)
  }
  return names
}

export function validateGeneratedAppCatalog(value: unknown): GeneratedAppCatalog {
  if (!isPlainObject(value)) throw new GeneratedAppI18nError('CATALOG_INVALID_SHAPE', 'root')

  const expectedNamespaces = Object.keys(REQUIRED_KEYS)
  for (const namespace of Object.keys(value)) {
    if (!expectedNamespaces.includes(namespace)) {
      throw new GeneratedAppI18nError('CATALOG_UNKNOWN_KEY', namespace)
    }
  }

  for (const namespace of expectedNamespaces as Array<keyof RequiredKeys>) {
    const section = value[namespace]
    if (!isPlainObject(section)) {
      throw new GeneratedAppI18nError('CATALOG_MISSING_KEY', namespace)
    }
    const expectedKeys = REQUIRED_KEYS[namespace] as readonly string[]
    for (const key of Object.keys(section)) {
      if (!expectedKeys.includes(key)) {
        throw new GeneratedAppI18nError('CATALOG_UNKNOWN_KEY', `${namespace}.${key}`)
      }
    }
    for (const key of expectedKeys) {
      const translation = section[key]
      const qualifiedKey = `${namespace}.${key}`
      if (typeof translation !== 'string') {
        throw new GeneratedAppI18nError('CATALOG_MISSING_KEY', qualifiedKey)
      }
      if (translation.trim().length === 0) {
        throw new GeneratedAppI18nError('CATALOG_EMPTY_VALUE', qualifiedKey)
      }
      placeholders(translation, qualifiedKey)
    }
  }

  return value as unknown as GeneratedAppCatalog
}

export function parseGeneratedAppCatalog(serialized: string): GeneratedAppCatalog {
  let value: unknown
  try {
    value = JSON.parse(serialized) as unknown
  } catch (error) {
    throw new GeneratedAppI18nError('CATALOG_INVALID_JSON', 'pt-BR', { cause: error })
  }
  return validateGeneratedAppCatalog(value)
}

export function loadGeneratedAppCatalog(
  source: string | URL = new URL('../i18n/generated-app/pt-BR.json', import.meta.url),
): GeneratedAppCatalog {
  let serialized: string
  try {
    serialized = readFileSync(source, 'utf8')
  } catch (error) {
    throw new GeneratedAppI18nError('CATALOG_READ_FAILED', String(source), { cause: error })
  }
  return parseGeneratedAppCatalog(serialized)
}

function escapeInterpolation(value: GeneratedAppInterpolationValue): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function translateGeneratedApp(
  catalog: GeneratedAppCatalog,
  key: GeneratedAppTranslationKey,
  params: GeneratedAppInterpolation = {},
): string {
  const [namespace, entry] = key.split('.') as [keyof GeneratedAppCatalog, string]
  const section = catalog[namespace] as unknown as Readonly<Record<string, string>>
  const template = section[entry]
  if (typeof template !== 'string') throw new GeneratedAppI18nError('TRANSLATION_MISSING', key)

  const expectedParams = placeholders(template, key)
  for (const name of expectedParams) {
    if (!Object.hasOwn(params, name)) {
      throw new GeneratedAppI18nError('INTERPOLATION_MISSING', `${key}:${name}`)
    }
  }
  for (const name of Object.keys(params)) {
    if (!expectedParams.has(name)) {
      throw new GeneratedAppI18nError('INTERPOLATION_UNKNOWN', `${key}:${name}`)
    }
  }

  return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/gu, (_match, name: string) => {
    return escapeInterpolation(params[name] as GeneratedAppInterpolationValue)
  })
}

let defaultCatalog: GeneratedAppCatalog | undefined

export function tGeneratedApp(
  key: GeneratedAppTranslationKey,
  params: GeneratedAppInterpolation = {},
): string {
  defaultCatalog ??= loadGeneratedAppCatalog()
  return translateGeneratedApp(defaultCatalog, key, params)
}
