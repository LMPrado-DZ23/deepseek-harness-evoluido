export function scanGeneratedContent(files: Readonly<Record<string, string>>): readonly string[] {
  const findings: string[] = []
  const secret = /(sk-[a-z0-9_-]{20,}|api[_-]?key\s*[:=]\s*["'][^"']{12,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/iu
  for (const [path, content] of Object.entries(files)) {
    if (secret.test(content)) findings.push(`${path}:SECRET_PATTERN`)
    if (containsCpf(content)) findings.push(`${path}:PII_PATTERN`)
  }
  return findings
}

export function isValidCpf(value: string): boolean {
  const digits = value.replace(/\D/gu, '')
  if (!/^\d{11}$/u.test(digits) || /^(\d)\1{10}$/u.test(digits)) return false
  const checksum = (length: 9 | 10): number => {
    let sum = 0
    for (let index = 0; index < length; index++) sum += Number(digits[index]) * (length + 1 - index)
    const remainder = (sum * 10) % 11
    return remainder === 10 ? 0 : remainder
  }
  return checksum(9) === Number(digits[9]) && checksum(10) === Number(digits[10])
}

function containsCpf(content: string): boolean {
  const formatted = content.match(/(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/gu) ?? []
  if (formatted.some(isValidCpf)) return true
  const labelled = content.match(/\bcpf\b[^\d]{0,24}(\d{11})(?!\d)/giu) ?? []
  return labelled.some(value => {
    const candidate = value.match(/\d{11}(?!\d)/u)![0]!
    return isValidCpf(candidate)
  })
}
