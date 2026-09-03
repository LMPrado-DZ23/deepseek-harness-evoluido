export function scanGeneratedContent(files: Readonly<Record<string, string>>): readonly string[] {
  const findings: string[] = []
  const secret = /(sk-[a-z0-9_-]{20,}|api[_-]?key\s*[:=]\s*["'][^"']{12,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/iu
  const pii = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b|\b\d{11}\b/u
  for (const [path, content] of Object.entries(files)) {
    if (secret.test(content)) findings.push(`${path}:SECRET_PATTERN`)
    if (pii.test(content)) findings.push(`${path}:PII_PATTERN`)
  }
  return findings
}
