/**
 * Versão do Service Worker para cache busting.
 * Incrementa automaticamente a cada build para forçar atualização do SW.
 */
export function swVersion(): string {
  return `sw-${Date.now()}`
}