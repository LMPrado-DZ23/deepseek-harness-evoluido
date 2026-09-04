export const STUDIO_CATEGORIES = [
  'landing-page',
  'catalog',
  'form-database',
  'crud-panel',
  'scheduling',
  'dashboard',
  'saas-authenticated',
] as const

export type Category = typeof STUDIO_CATEGORIES[number]
