import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'
import { designLogoSchema, rgbToHsl, type DesignLogo } from './design.js'
import { t } from './i18n.js'
import { PromptToAppError } from './service.js'

const MAX_INPUT_BYTES = 2 * 1024 * 1024
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_INPUT_PIXELS = 16_000_000

export interface LogoProcessorPort {
  process(scope: { readonly orgId: string; readonly tenantId: string }, input: Buffer, contentType: string): Promise<DesignLogo>
}

export class SharpLogoProcessor implements LogoProcessorPort {
  constructor(private readonly root: string) {}

  async process(scope: { readonly orgId: string; readonly tenantId: string }, input: Buffer, contentType: string): Promise<DesignLogo> {
    if (input.byteLength === 0 || input.byteLength > MAX_INPUT_BYTES) throw invalidLogo()
    if (contentType !== 'image/png' && contentType !== 'image/jpeg') throw invalidLogo()
    if (!hasAllowedSignature(input)) throw invalidLogo()

    let output: Buffer; let info: { width: number; height: number }; let dominant: { r: number; g: number; b: number }
    try {
      const image = sharp(input, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS })
      const metadata = await image.metadata()
      if (metadata.format !== 'png' && metadata.format !== 'jpeg') throw invalidLogo()
      const stats = await image.stats()
      const rendered = await image.rotate().resize({ width: 1_600, height: 1_600, fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })
      output = rendered.data; info = { width: rendered.info.width, height: rendered.info.height }; dominant = stats.dominant
    } catch (error) {
      if (error instanceof PromptToAppError) throw error
      throw invalidLogo()
    }
    if (output.byteLength > MAX_OUTPUT_BYTES) throw invalidLogo()

    const sha256 = createHash('sha256').update(output).digest('hex')
    const scopeHash = createHash('sha256').update(`${scope.orgId}\0${scope.tenantId}`).digest('hex')
    const relativePath = `logos/${scopeHash}/${sha256}.png` as const
    const target = resolve(this.root, relativePath)
    await mkdir(resolve(this.root, 'logos', scopeHash), { recursive: true })
    await writeFile(target, output, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
    return designLogoSchema.parse({
      sha256, relative_path: relativePath, mime: 'image/png', size_bytes: output.byteLength,
      width: info.width, height: info.height, extracted_primary: rgbToHsl(dominant.r, dominant.g, dominant.b),
    })
  }
}

function hasAllowedSignature(input: Buffer): boolean {
  const png = input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const jpeg = input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff
  return png || jpeg
}

function invalidLogo(): PromptToAppError { return new PromptToAppError('INVALID', t('errors.invalidLogo')) }
