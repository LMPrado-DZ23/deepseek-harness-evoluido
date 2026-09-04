import { resolve } from 'node:path'

/** The production plugin has one reviewed framework/template in v1. */
export function productionTemplateDirectory(projectRoot: string): string {
  return resolve(projectRoot, 'templates', 'nextjs-app@1')
}
