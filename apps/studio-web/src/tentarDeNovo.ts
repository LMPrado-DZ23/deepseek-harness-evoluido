/**
 * Quando a tela oferece "Tentar de novo".
 *
 * Só oferecia depois de uma interrupção. Medido em 19/09/2026 na jornada real:
 * a criação terminou em "Não passou" (falha de montagem), o servidor aceitava
 * começar de novo com o MESMO plano, e a tela não tinha botão — a única saída
 * era escrever um pedido de alteração e montar um plano novo, minutos de
 * modelo por nada. A lista é a mesma do servidor (`GENERATION_START_STATES`,
 * menos a aprovação do plano, que tem o botão "Iniciar criação").
 */
export const ESTADOS_DE_TENTAR_DE_NOVO: ReadonlySet<string> = new Set(['INTERRUPTED', 'BUILD_FAILED', 'TESTS_FAILED', 'CANCELLED'])

export function podeTentarDeNovo(estado: string | undefined): boolean {
  return estado !== undefined && ESTADOS_DE_TENTAR_DE_NOVO.has(estado)
}
