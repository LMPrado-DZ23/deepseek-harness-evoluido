import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
export function secretHash(value) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}
export function secretMatches(value, expectedHash) {
    const actual = Buffer.from(secretHash(value), 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function newOpaqueSecret(bytes = 32) {
    return randomBytes(bytes).toString('base64url');
}
export function newMagicCode() {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
}
export function truncateIp(input) {
    if (input === undefined || input.trim() === '')
        return 'unknown';
    const value = input.split(',')[0].trim();
    if (isIP(value) === 4) {
        const octets = value.split('.');
        return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
    }
    if (isIP(value) === 6) {
        return `${value.split(':').slice(0, 3).join(':')}::/48`;
    }
    return 'invalid';
}
