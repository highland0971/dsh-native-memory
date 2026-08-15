// Plugin configuration. Zod v4, matching deepseek-harness's own
// storage-domain dependency (packages/storage/storage-domain/package.json:
// "zod": "^4.4.3"). The bundle patch (cordis.patch.yml) ships defaults;
// a user's profile cordis.patch.yml can override any field — last layer wins.

import { z } from 'zod'

export const Config = z.object({
  /** Inject the bounded per-workspace profile into every session prompt. */
  injectProfile: z.boolean().default(true),
  /** Hard cap on durable facts per workspace. */
  maxFactsPerWorkspace: z.number().int().min(1).max(10000).default(300),
  /** Hard cap on one fact's text, in Unicode code points. */
  maxFactChars: z.number().int().min(1).max(1_000_000).default(2000),
  /** Hard cap on the number of profile entries per workspace. */
  maxProfileEntries: z.number().int().min(0).max(100).default(8),
  /** Hard cap on one profile entry, in Unicode code points. */
  maxProfileEntryChars: z.number().int().min(1).max(100_000).default(240),
  /** Route every write action through the host approval stack. */
  approvalWrites: z.boolean().default(true),
})

export type ConfigType = z.infer<typeof Config>
