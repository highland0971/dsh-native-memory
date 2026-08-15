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
  /**
   * Secret handling for memory writes: 'reject' fails the write (default),
   * 'mask' stores the text with secrets replaced by [REDACTED], 'off' stores
   * as-is. Prompt injection and tool echo are ALWAYS masked regardless.
   */
  secretPolicy: z.enum(['reject', 'mask', 'off']).default('reject'),
  /**
   * Session-end memory proposal (v0.3.0, OFF by default): when enabled, a
   * finished session is distilled once with a cheap LLM call into candidate
   * facts. Candidates are PROPOSALS only — they are shown in the next
   * sessions' prompt and become facts only through the approval-gated
   * memory_remember. Writes stay半自动: the LLM proposes, the human approves.
   */
  proposeOnSessionEnd: z.boolean().default(false),
  /** LLM route for the distillation call. */
  proposalProvider: z.string().min(1).default('deepseek'),
  proposalModel: z.string().min(1).default('deepseek-v4-flash'),
  /** Upper bound on candidate facts per distillation. */
  proposalMaxFacts: z.number().int().min(1).max(20).default(8),
  /** Upper bound on pending proposals per workspace (oldest expire first). */
  proposalMaxPending: z.number().int().min(1).max(64).default(16),
  /** Pending proposals older than this many days are dropped from display. */
  proposalTtlDays: z.number().int().min(1).max(365).default(7),
  /**
   * Compaction drift guard (ON by default): when a compaction summary drops
   * literal anchors from the shadowed turns, record a bounded alarm and show
   * it in the next sessions' prompt as DATA to verify. Deterministic, zero
   * LLM, zero extra model call.
   */
  compactionGuard: z.boolean().default(true),
  /** Drift alarms older than this many hours are dropped from display. */
  guardAlarmTtlHours: z.number().int().min(1).max(720).default(24),
  /** Upper bound on active drift alarms per workspace (oldest expire first). */
  guardAlarmMax: z.number().int().min(1).max(16).default(3),
}).refine(
  config => config.recallFreshWindowDays <= config.recallStaleWindowDays,
  {
    message: 'recallFreshWindowDays must be ≤ recallStaleWindowDays '
      + '(otherwise the intermediate "current" freshness window is unreachable)',
  },
)

export type ConfigType = z.infer<typeof Config>
