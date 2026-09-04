import { describe, expect, it } from 'vitest'
import { apiFailureKind, apiFailureMessage, apiFailureText } from './apiFailure'
import { OFFLINE_ERROR_CODE, SERVICE_UNREACHABLE_ERROR_CODE } from './policy'
import t from '../i18n/pwa.pt-BR.json'

describe('telling the two network causes apart, for reads and for mutations', () => {
  it('classifies the worker codes and a bare fetch failure by whether the device has a network', () => {
    expect(apiFailureKind(new Error(OFFLINE_ERROR_CODE), false)).toBe('OFFLINE')
    expect(apiFailureKind(new Error(SERVICE_UNREACHABLE_ERROR_CODE), true)).toBe('SERVICE_UNREACHABLE')
    // The code the worker sent wins over navigator.onLine, which can lie in both directions.
    expect(apiFailureKind(new Error(OFFLINE_ERROR_CODE), true)).toBe('OFFLINE')
    expect(apiFailureKind(new Error(SERVICE_UNREACHABLE_ERROR_CODE), false)).toBe('SERVICE_UNREACHABLE')
    // No worker yet: fetch rejects with a TypeError and only the network flag separates the causes.
    expect(apiFailureKind(new TypeError('Failed to fetch'), true)).toBe('SERVICE_UNREACHABLE')
    expect(apiFailureKind(new TypeError('Failed to fetch'), false)).toBe('OFFLINE')
    // An error the server itself sent is neither, and must keep its own sentence.
    expect(apiFailureKind(new Error('PLAN_NOT_APPROVED'), true)).toBe('UNKNOWN')
  })

  it('gives a GET and a mutation different sentences for OFFLINE, and the same one for SERVICE_UNREACHABLE', () => {
    const offline = new Error(OFFLINE_ERROR_CODE)
    const unreachable = new Error(SERVICE_UNREACHABLE_ERROR_CODE)
    expect(apiFailureMessage(offline, false, 'read')).toBe(t.offline.banner)
    expect(apiFailureMessage(offline, false, 'mutation')).toBe(t.offline.blockedAction)
    expect(apiFailureMessage(offline, false, 'read')).not.toBe(apiFailureMessage(offline, false, 'mutation'))
    expect(apiFailureMessage(unreachable, true, 'read')).toBe(t.offline.serviceUnreachable)
    expect(apiFailureMessage(unreachable, true, 'mutation')).toBe(t.offline.serviceUnreachable)
    // The two causes never share a sentence: that was the whole point of separating them.
    expect(apiFailureMessage(offline, false, 'mutation')).not.toBe(apiFailureMessage(unreachable, true, 'mutation'))
    expect(apiFailureMessage(offline, false, 'read')).not.toBe(apiFailureMessage(unreachable, true, 'read'))
    expect(apiFailureMessage(new Error('PLAN_NOT_APPROVED'), true, 'mutation')).toBeUndefined()
  })

  it('the blocked-action sentence promises no queue and no background sync', () => {
    // There is no queue and no background sync. Saying the action will be sent later would be a lie.
    for (const sentence of [t.offline.blockedAction, t.offline.banner, t.offline.serviceUnreachable]) {
      expect(sentence).not.toMatch(/\bfila\b|sincroniz|segundo plano|assim que a (?:internet|conex)[^.]*\benviar|ser[áa] enviad|vamos enviar|guardad[ao]s?\b/iu)
      expect(sentence).not.toMatch(/\bpront[oa]s?\b/iu)
    }
    // It does tell the person their text is still there and that they may try again.
    expect(t.offline.blockedAction).toMatch(/tente de novo/iu)
  })

  it('keeps the server sentence when the failure is not one of the two network causes, and never shows an empty message', () => {
    expect(apiFailureText(new Error('O plano precisa ser aprovado.'), true, 'mutation', 'x')).toBe('O plano precisa ser aprovado.')
    expect(apiFailureText(new Error('   '), true, 'mutation', 'atenção')).toBe('atenção')
    expect(apiFailureText(undefined, true, 'mutation', 'atenção')).toBe('atenção')
    expect(apiFailureText(OFFLINE_ERROR_CODE, false, 'mutation', 'x')).toBe(t.offline.blockedAction)
  })
})
