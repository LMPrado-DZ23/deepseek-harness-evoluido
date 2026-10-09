// Covers store materialization (10m), adapter verification (8m), bounded overhead, and the
// listener's complete independent deadline. Registry reload never truncates either phase.
// Em arquivo próprio porque o INSTALADOR espera o socket pelo mesmo orçamento, e
// importar o gerente inteiro no instalador criaria um ciclo entre os dois.
export const DEFAULT_SLOT_STARTUP_TIMEOUT_MS = 21 * 60_000
