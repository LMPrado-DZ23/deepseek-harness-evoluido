import { type PropsWithChildren, useEffect } from 'react'
import { currentSessionMode } from './currentSession'
import { browserSessionGeneration, followRemoteSessionRevocation, listenForSessionRevocation } from './sessionRevocation'
import { clearOwnedBrowserSessionStateInBrowser } from './signOut'

export function SessionRevocationBoundary({ children }: PropsWithChildren) {
  useEffect(() => listenForSessionRevocation(() => followRemoteSessionRevocation({
    currentMode: currentSessionMode,
    currentGeneration: browserSessionGeneration,
    clearOwnedState: clearOwnedBrowserSessionStateInBrowser,
    redirect: path => window.location.assign(path),
  })), [])
  return children
}
