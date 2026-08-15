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
  /**
   * Recall freshness windows (days since updatedAt): ≤ fresh = weight 1.0,
   * ≤ stale = 0.8, older = 0.5. Acts WITHIN a recall tier only — the three-tier
   * text ranking always dominates (tag > substring > fuzzy).
   */
  recallFreshWindowDays: z.number().int().min(0).default(7),
  recallStaleWindowDays: z.number().int().min(0).default(90),
})

export type ConfigType = z.infer<typeof Config>
