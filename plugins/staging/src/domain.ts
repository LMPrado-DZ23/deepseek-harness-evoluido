import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import {
  STUDIO_STAGING_RELEASES_PHYSICAL_DOMAIN,
  stagingReleaseSchema,
  type StagingRelease,
} from './model.js'

declare const stagingKeyBrand: unique symbol
export type StagingKey = string & { readonly [stagingKeyBrand]: true }

export const studioStagingReleasesDomainSpec = defineDomain({
  name: STUDIO_STAGING_RELEASES_PHYSICAL_DOMAIN,
  version: 1,
  tables: { releases: domainTable<StagingKey, StagingRelease>(stagingReleaseSchema) },
})
