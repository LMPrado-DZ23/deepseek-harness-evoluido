/**
 * The restore path still materialises one complete JSON document for strict
 * schema and checksum validation. Keep its advertised ceiling below the
 * measured/operator heap boundary until the format has a real streaming
 * parser. Callers may choose a smaller value, never a larger one.
 */
export const OPERATOR_BUNDLE_MAX_BYTES = 64 * 1024 * 1024;
export function assertOperatorBundleLimit(value, label = 'maxBytes') {
    if (!Number.isSafeInteger(value) || value < 1 || value > OPERATOR_BUNDLE_MAX_BYTES) {
        throw new Error(`${label} must be an integer between 1 and ${String(OPERATOR_BUNDLE_MAX_BYTES)}`);
    }
    return value;
}
