/**
 * The restore path still materialises one complete JSON document for strict
 * schema and checksum validation. Keep its advertised ceiling below the
 * measured/operator heap boundary until the format has a real streaming
 * parser. Callers may choose a smaller value, never a larger one.
 */
export declare const OPERATOR_BUNDLE_MAX_BYTES: number;
export declare function assertOperatorBundleLimit(value: number, label?: string): number;
//# sourceMappingURL=operator-limits.d.ts.map