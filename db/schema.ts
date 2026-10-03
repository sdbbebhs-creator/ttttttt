import { pgTable, text, jsonb, timestamp, primaryKey, index, bigserial } from 'drizzle-orm/pg-core';

export const vocabItems = pgTable(
  'vocab_items',
  {
    userId: text('user_id').notNull(),
    id: text('id').notNull(),
    data: jsonb('data').notNull(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.id] })]
);

export const grammarItems = pgTable(
  'grammar_items',
  {
    userId: text('user_id').notNull(),
    id: text('id').notNull(),
    data: jsonb('data').notNull(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.id] })]
);


// Synced localStorage values (FSRS scheduler settings, target retention, rank…), one row per storage key.
export const userSettings = pgTable(
  'user_settings',
  {
    userId: text('user_id').notNull(),
    key: text('key').notNull(),
    data: jsonb('data').notNull(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.key] })]
);

// Append-only FSRS review history (feeds the weights optimizer on every device).
// `seq` is the server-side arrival order: devices pull "everything after the last seq I saw",
// so a review made offline on another device (older `ts`) is still picked up later.
export const reviewLogs = pgTable(
  'review_logs',
  {
    userId: text('user_id').notNull(),
    id: text('id').notNull(),
    ts: text('ts').notNull(),
    data: jsonb('data').notNull(),
    seq: bigserial('seq', { mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.id] }),
    index('review_logs_user_ts_idx').on(table.userId, table.ts),
    index('review_logs_user_seq_idx').on(table.userId, table.seq),
  ]
);
