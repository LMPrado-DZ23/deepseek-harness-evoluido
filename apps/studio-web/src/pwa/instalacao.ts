/**
 * The "install FRIGG on this device" offer can be turned down, and stays turned down on this device.
 *
 * Measured on 20/09/2026 in the owner's Chrome: the offer is a fixed chip in the bottom-right corner,
 * and with the prototype preview open it sat on top of the generated app, with no way to put it
 * away short of installing. The only per-device fact kept is that the person said no.
 */
export const CHAVE_INSTALACAO_DISPENSADA = 'frigg.instalacao.dispensada'

/** Storage as this module needs it; a browser that refuses storage is simply "not dismissed". */
export type ArmazenamentoDaOferta = Pick<Storage, 'getItem' | 'setItem'>

/**
 * Has the person already turned the offer down on this device?
 * @param armazenamento - the device storage, or nothing when the browser refuses it.
 * @returns true only when the refusal was recorded and can be read back.
 */
export function instalacaoDispensada(armazenamento: ArmazenamentoDaOferta | undefined): boolean {
  try { return armazenamento?.getItem(CHAVE_INSTALACAO_DISPENSADA) === '1' } catch { return false }
}

/**
 * Records that the person turned the offer down. When storage is refused the offer still goes away
 * for this screen; it comes back next time, which is the honest outcome of not being able to remember.
 * @param armazenamento - the device storage, or nothing.
 */
export function dispensarInstalacao(armazenamento: ArmazenamentoDaOferta | undefined): void {
  try { armazenamento?.setItem(CHAVE_INSTALACAO_DISPENSADA, '1') } catch { /* nothing to remember with */ }
}
