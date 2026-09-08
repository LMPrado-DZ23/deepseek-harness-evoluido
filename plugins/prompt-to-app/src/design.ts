import { createHash } from 'node:crypto'
import { z } from 'zod'
import { t } from './i18n.js'

export const designPresetSchema = z.enum(['modern', 'professional', 'colorful', 'brand'])
export const hslColorSchema = z.object({
  h: z.number().int().min(0).max(359),
  s: z.number().int().min(0).max(100),
  l: z.number().int().min(0).max(100),
}).strict()

const accessibleColorSchema = z.object({
  value: hslColorSchema,
  foreground: hslColorSchema,
}).strict().superRefine((value, context) => {
  if (contrastRatio(value.value, value.foreground) < 4.5) {
    context.addIssue({ code: 'custom', path: ['foreground'], message: t('errors.designContrast') })
  }
})

export const designLogoSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  relative_path: z.string().regex(/^logos\/[a-f0-9]{64}\/[a-f0-9]{64}\.png$/u),
  mime: z.literal('image/png'),
  size_bytes: z.number().int().positive().max(2 * 1024 * 1024),
  width: z.number().int().positive().max(1_600),
  height: z.number().int().positive().max(1_600),
  extracted_primary: hslColorSchema,
}).strict()

const fontWeightSchema = z.union([z.literal(400), z.literal(500), z.literal(600), z.literal(700)])
const typographySchema = z.object({
  family: z.enum(['geist-sans', 'source-serif']),
  weights: z.array(fontWeightSchema).min(1).max(4).refine(values => new Set(values).size === values.length),
}).strict()

export const designSpecV1Schema = z.object({
  schema_version: z.literal(1),
  preset: designPresetSchema,
  palette: z.object({
    primary: accessibleColorSchema,
    secondary: accessibleColorSchema,
    neutral: accessibleColorSchema,
    success: accessibleColorSchema,
    warning: accessibleColorSchema,
    danger: accessibleColorSchema,
  }).strict(),
  typography: typographySchema,
  radius: z.enum(['compact', 'balanced', 'rounded']),
  density: z.enum(['compact', 'comfortable']),
  tone: z.enum(['friendly', 'formal']),
  logo: designLogoSchema.nullable(),
}).strict()

export const designSelectionSchema = z.object({
  preset: designPresetSchema,
  primary: hslColorSchema.optional(),
  font: z.enum(['geist-sans', 'source-serif']).default('geist-sans'),
  radius: z.enum(['compact', 'balanced', 'rounded']).default('balanced'),
  density: z.enum(['compact', 'comfortable']).default('comfortable'),
  tone: z.enum(['friendly', 'formal']).default('friendly'),
}).strict().superRefine((value, context) => {
  if (value.preset === 'brand' && value.primary === undefined) context.addIssue({ code: 'custom', path: ['primary'], message: t('errors.designPrimary') })
})

export type HslColor = z.infer<typeof hslColorSchema>
export type DesignSpecV1 = z.infer<typeof designSpecV1Schema>
export type DesignSelection = z.input<typeof designSelectionSchema>
export type DesignLogo = z.infer<typeof designLogoSchema>

const PRESET_PRIMARY: Readonly<Record<Exclude<DesignSpecV1['preset'], 'brand'>, HslColor>> = {
  modern: { h: 217, s: 91, l: 50 },
  professional: { h: 222, s: 72, l: 32 },
  colorful: { h: 269, s: 82, l: 45 },
}

const SHARED_PALETTE = {
  success: { h: 145, s: 63, l: 32 },
  warning: { h: 34, s: 88, l: 42 },
  danger: { h: 0, s: 72, l: 42 },
} as const satisfies Readonly<Record<string, HslColor>>

export function createDesignSpec(input: DesignSelection, logo: DesignLogo | null = null): DesignSpecV1 {
  const selection = designSelectionSchema.parse(input)
  const primary = selection.preset === 'brand' ? selection.primary! : PRESET_PRIMARY[selection.preset]
  const secondary = selection.preset === 'colorful' ? { h: 186, s: 76, l: 34 } : { h: primary.h, s: Math.min(primary.s, 36), l: 88 }
  const neutral = selection.preset === 'professional' ? { h: 222, s: 24, l: 94 } : { h: 214, s: 28, l: 95 }
  const pair = (value: HslColor) => ({ value, foreground: accessibleForeground(value) })
  return designSpecV1Schema.parse({
    schema_version: 1,
    preset: selection.preset,
    palette: {
      primary: pair(primary), secondary: pair(secondary), neutral: pair(neutral),
      success: pair(SHARED_PALETTE.success), warning: pair(SHARED_PALETTE.warning), danger: pair(SHARED_PALETTE.danger),
    },
    typography: { family: selection.font, weights: [400, 500, 600, 700] },
    radius: selection.radius,
    density: selection.density,
    tone: selection.tone,
    logo,
  })
}

export function renderDesignTokens(spec: DesignSpecV1): string {
  const value = designSpecV1Schema.parse(spec)
  const token = (role: keyof DesignSpecV1['palette'], field: 'value' | 'foreground') => cssHsl(value.palette[role][field])
  const radius = { compact: '0.375rem', balanced: '0.75rem', rounded: '1.125rem' }[value.radius]
  const spacing = value.density === 'compact' ? '0.875rem' : '1rem'
  const font = value.typography.family === 'source-serif' ? 'var(--font-dz23-serif)' : 'var(--font-dz23-sans)'
  // Este texto NÃO vai para o catálogo de propósito: ele é o cabeçalho do
  // arquivo CSS gerado, não fala do produto para ninguém, e é comparado byte a
  // byte pelo controle de integridade do template. Traduzi-lo quebraria a
  // comparação sem beneficiar pessoa alguma.
  return `/* DZ23 DesignSpec v1 ${designSpecHash(value)} — arquivo protegido */
:root {
  --background: ${token('neutral', 'value')};
  --foreground: ${token('neutral', 'foreground')};
  --card: 0 0% 100%;
  --card-foreground: ${token('neutral', 'foreground')};
  --primary: ${token('primary', 'value')};
  --primary-foreground: ${token('primary', 'foreground')};
  --secondary: ${token('secondary', 'value')};
  --secondary-foreground: ${token('secondary', 'foreground')};
  --muted: ${token('neutral', 'value')};
  --muted-foreground: ${token('neutral', 'foreground')};
  --accent: ${token('secondary', 'value')};
  --accent-foreground: ${token('secondary', 'foreground')};
  --success: ${token('success', 'value')};
  --success-foreground: ${token('success', 'foreground')};
  --warning: ${token('warning', 'value')};
  --warning-foreground: ${token('warning', 'foreground')};
  --danger: ${token('danger', 'value')};
  --danger-foreground: ${token('danger', 'foreground')};
  --destructive: ${token('danger', 'value')};
  --border: 214 24% 82%;
  --input: 214 24% 82%;
  --ring: ${token('primary', 'value')};
  --radius: ${radius};
  --content-spacing: ${spacing};
  --font-body: ${font};
}
`
}

export function designSpecHash(spec: DesignSpecV1): string { return createHash('sha256').update(JSON.stringify(spec)).digest('hex') }

export function contrastRatio(left: HslColor, right: HslColor): number {
  const [a, b] = [relativeLuminance(left), relativeLuminance(right)].sort((x, y) => y - x)
  return (a! + 0.05) / (b! + 0.05)
}

export function rgbToHsl(red: number, green: number, blue: number): HslColor {
  const [r, g, b] = [red, green, blue].map(value => Math.max(0, Math.min(255, value)) / 255)
  const max = Math.max(r!, g!, b!); const min = Math.min(r!, g!, b!); const delta = max - min
  let hue = 0
  if (delta !== 0) hue = max === r ? 60 * (((g! - b!) / delta) % 6) : max === g ? 60 * ((b! - r!) / delta + 2) : 60 * ((r! - g!) / delta + 4)
  const lightness = (max + min) / 2
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1))
  return { h: Math.round((hue + 360) % 360), s: Math.round(saturation * 100), l: Math.round(lightness * 100) }
}

function accessibleForeground(primary: HslColor): HslColor {
  const dark = { h: 0, s: 0, l: 0 }; const light = { h: 0, s: 0, l: 100 }
  return contrastRatio(primary, light) >= contrastRatio(primary, dark) ? light : dark
}

function cssHsl(value: HslColor): string { return `${value.h} ${value.s}% ${value.l}%` }

function relativeLuminance(color: HslColor): number {
  const [r, g, b] = hslToRgb(color).map(channel => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function hslToRgb({ h, s, l }: HslColor): [number, number, number] {
  const saturation = s / 100; const lightness = l / 100
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const x = chroma * (1 - Math.abs((h / 60) % 2 - 1)); const match = lightness - chroma / 2
  const rgb: [number, number, number] = h < 60 ? [chroma, x, 0] : h < 120 ? [x, chroma, 0] : h < 180 ? [0, chroma, x] : h < 240 ? [0, x, chroma] : h < 300 ? [x, 0, chroma] : [chroma, 0, x]
  return rgb.map(channel => channel + match) as [number, number, number]
}
