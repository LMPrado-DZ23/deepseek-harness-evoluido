import { fileURLToPath } from 'node:url'

/** The production plugin has one reviewed framework/template in v1. */
export function productionTemplateDirectory(): string {
  return fileURLToPath(new URL('../template/nextjs-app@1/', import.meta.url))
}
