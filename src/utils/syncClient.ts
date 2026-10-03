import { supabase } from './supabaseClient';
import type { VocabItem, GrammarItem, ReviewLog } from '../types';
import {
  ensureFSRSVocab,
  ensureFSRSGrammar,
  getReviewLogs,
  mergeReviewLogs,
  reviewLogId,
  readSyncedSettings,
  writeSyncedSettings,
  clearLocalItems,
  clearLocalReviewLogs,
  SYNCED_SETTING_KEYS,
} from './storage';

// ============================================================================
// DỮ LIỆU THEO TÀI KHOẢN (Supabase Database trực tiếp)
// ----------------------------------------------------------------------------
// Tài khoản trên máy chủ là nguồn chính. Máy chỉ giữ một bản sao để mở app
// nhanh và dùng khi mất mạng. Mỗi thiết bị lưu "ảnh chụp" (hash) của những gì
// tài khoản đang có sau lần đồng bộ gần nhất; so dữ liệu trên máy với ảnh chụp
// sẽ biết chính xác thẻ nào vừa thêm/sửa/xóa — kể cả thay đổi tạo lúc mất mạng
// hoặc trước khi F5 — rồi chỉ gửi phần thay đổi đó (hàng chờ = phần chênh lệch).
// ============================================================================

const API = '/api/data';
const SYNC_STATE_PREFIX = 'vocabbank_sync_state_v1:';
const PENDING_STASH_PREFIX = 'vocabbank_pending_stash_v1:';
const DATA_OWNER_KEY = 'vocabbank_data_owner';
// Dấu vết chủ sở hữu từ các phiên bản cũ (Supabase), dùng để không nhận nhầm dữ liệu trên máy
const LEGACY_OWNER_KEY = 'sync_cache_owner_v1';
const LEGACY_MIRROR_PREFIX = 'supabase_items_mirror_v1:';
const LEGACY_OUTBOX_PREFIX = 'sync_outbox_v1_';
/** Khóa cài đặt trên máy chủ đánh dấu đã chuyển dữ liệu từ các bảng Supabase cũ */
const SUPABASE_MIGRATED_KEY = '__supabase_migrated_v1';
// Mỗi request giữ dưới giới hạn 6 MB của Netlify Functions (thẻ có thể chứa ảnh base64)
const MAX_PUSH_BYTES = 3_500_000;
const MAX_LOGS_PER_PUSH = 2000;
const SUPABASE_PAGE_SIZE = 500;

type ItemKind = 'vocab' | 'grammar';
type AnyItem = VocabItem | GrammarItem;

interface SyncState {
  vocab: Record<string, string>;
  grammar: Record<string, string>;
  settings: Record<string, string | null>;
  /** Mốc thời gian của lượt ôn mới nhất đã gửi lên tài khoản */
  logsPushedThrough: string;
  /** Số thứ tự (phía máy chủ) của lượt ôn mới nhất đã tải về */
  logsSeq: number;
  /** Dấu phiên bản dữ liệu của tài khoản ở lần tải gần nhất */
  version: string;
  cursors: Record<ItemKind, string>;
}

export interface SyncedData {
  vocab: VocabItem[];
  grammar: GrammarItem[];
  /** Cài đặt FSRS / Rank trên máy vừa được thay bằng bản từ tài khoản */
  settingsChanged: boolean;
  logsChanged: boolean;
}

export type GetLists = () => { vocab: VocabItem[]; grammar: GrammarItem[] };

// ---------------------------------------------------------------------------
// Trạng thái hiển thị (Navbar): mất mạng, số thay đổi đang chờ, đang lưu
// ---------------------------------------------------------------------------

export interface SyncStatus {
  online: boolean;
  pending: number;
  syncing: boolean;
  /** Lần gửi/tải gần nhất thất bại vì không có mạng */
  networkError: boolean;
  lastSyncedAt: number | null;
}

let status: SyncStatus = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  pending: 0,
  syncing: false,
  networkError: false,
  lastSyncedAt: null,
};
const statusListeners = new Set<() => void>();

function setStatus(patch: Partial<SyncStatus>): void {
  const next = { ...status, ...patch };
  if ((Object.keys(patch) as (keyof SyncStatus)[]).every((k) => next[k] === status[k])) return;
  status = next;
  statusListeners.forEach((l) => l());
}

export const getSyncStatus = (): SyncStatus => status;

export function subscribeSyncStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => setStatus({ online: true }));
  window.addEventListener('offline', () => setStatus({ online: false }));
}

class NetworkError extends Error {}

const isNetworkError = (err: unknown) =>
  err instanceof NetworkError || (typeof navigator !== 'undefined' && navigator.onLine === false);

/** Ghi nhận kết quả 1 lượt gửi/tải vào trạng thái hiển thị */
function noteResult(err: unknown | null): void {
  if (!err) setStatus({ networkError: false, online: true, lastSyncedAt: Date.now() });
  else if (isNetworkError(err)) setStatus({ networkError: true });
}

// ---------------------------------------------------------------------------
// Hash helpers (cached per object: React only creates new objects for changed items)
// ---------------------------------------------------------------------------

const hashCache = new WeakMap<object, string>();

function hashString(str: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 5381;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = (Math.imul(h2, 33) + c) | 0;
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}${str.length.toString(36)}`;
}

export function hashItem(item: object): string {
  let h = hashCache.get(item);
  if (!h) {
    h = hashString(JSON.stringify(item));
    hashCache.set(item, h);
  }
  return h;
}

const normalize = (kind: ItemKind, raw: unknown): AnyItem =>
  kind === 'vocab' ? ensureFSRSVocab(raw) : ensureFSRSGrammar(raw);

/** Bản nào đã được ôn gần hơn / nhiều hơn thì "mới" hơn (dùng khi gộp dữ liệu cũ) */
function progressKey(item: any): string {
  const last = String(item?.last_review || item?.lastReviewed || '');
  const reps = String(Number(item?.reps) || 0).padStart(6, '0');
  return `${last}|${reps}`;
}

// ---------------------------------------------------------------------------
// Local sync state & quyền sở hữu dữ liệu trên máy
// ---------------------------------------------------------------------------

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {}
}

function loadSyncState(userId: string): SyncState | null {
  try {
    const raw = localStorage.getItem(SYNC_STATE_PREFIX + userId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      vocab: parsed.vocab || {},
      grammar: parsed.grammar || {},
      settings: parsed.settings || {},
      logsPushedThrough: parsed.logsPushedThrough || '',
      logsSeq: Number(parsed.logsSeq) || 0,
      version: parsed.version || '',
      cursors: { vocab: parsed.cursors?.vocab || '', grammar: parsed.cursors?.grammar || '' },
    };
  } catch {
    return null;
  }
}

function saveSyncState(userId: string, state: SyncState): void {
  try {
    localStorage.setItem(SYNC_STATE_PREFIX + userId, JSON.stringify(state));
  } catch (err) {
    console.warn('Không lưu được trạng thái đồng bộ:', err);
  }
}

function legacyKeysWithPrefix(prefix: string): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) keys.push(key);
    }
  } catch {}
  return keys;
}

/**
 * Chủ sở hữu bản sao trên máy. Bản cũ chưa từng được gắn tài khoản thì dò theo
 * dấu vết của các phiên bản trước (Supabase); không có dấu vết nào → null.
 */
function getDataOwner(): string | null {
  const owner = safeGet(DATA_OWNER_KEY) || safeGet(LEGACY_OWNER_KEY);
  if (owner) return owner;
  const mirrors = legacyKeysWithPrefix(LEGACY_MIRROR_PREFIX).map((k) => k.slice(LEGACY_MIRROR_PREFIX.length));
  return mirrors.length === 1 ? mirrors[0] : null;
}

function setDataOwner(userId: string): void {
  try {
    localStorage.setItem(DATA_OWNER_KEY, userId);
  } catch {}
}

/** Xóa toàn bộ bản sao trên máy (thẻ, cài đặt, lịch sử ôn, trạng thái đồng bộ). */
export async function clearLocalCopy(): Promise<void> {
  writeSyncedSettings(Object.fromEntries(SYNCED_SETTING_KEYS.map((k) => [k, null])));
  clearLocalReviewLogs();
  [
    ...legacyKeysWithPrefix(SYNC_STATE_PREFIX),
    ...legacyKeysWithPrefix(LEGACY_MIRROR_PREFIX),
    ...legacyKeysWithPrefix(LEGACY_OUTBOX_PREFIX),
    DATA_OWNER_KEY,
    LEGACY_OWNER_KEY,
    'study_last_date',
    'study_streak_count',
  ].forEach(safeRemove);
  await clearLocalItems();
  setStatus({ pending: 0, networkError: false, lastSyncedAt: null });
}

/**
 * Gọi ngay khi biết tài khoản đang đăng nhập. Nếu bản sao trên máy thuộc tài khoản
 * khác thì xóa đi để không ai thấy hoặc nhận nhầm dữ liệu của người khác.
 * Trả về true nếu đã xóa (app cần làm trống danh sách đang hiển thị).
 */
export async function claimLocalCopy(userId: string): Promise<boolean> {
  const owner = getDataOwner();
  if (owner && owner !== userId) {
    await clearLocalCopy();
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Supabase Database trực tiếp
// ---------------------------------------------------------------------------
// Auth + app data đều nằm trong Supabase. Frontend dùng publishable key và RLS
// giới hạn mọi truy vấn theo auth.uid(), nên mỗi tài khoản chỉ thấy dữ liệu của mình.

async function currentUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error('Not signed in');
  return data.user.id;
}

const updatedSince = (since: string) => {
  if (!since) return null;
  const d = new Date(since);
  if (Number.isNaN(d.getTime())) return since;
  return new Date(d.getTime() - 2 * 60 * 1000).toISOString();
};

async function fetchItems(kind: ItemKind, since = ''): Promise<{ items: AnyItem[]; ids: string[] | null }> {
  const table = kind === 'vocab' ? 'vocab_items' : 'grammar_items';
  const cursor = updatedSince(since);
  const rows: any[] = [];
  const PAGE = 1000;

  for (let from = 0; ; from += PAGE) {
    let query = supabase
      .from(table)
      .select('id,data,updated_at')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (cursor) query = query.gt('updated_at', cursor);
    const { data, error } = await query;
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }

  const items = rows
    .filter((r: any) => r?.data)
    .map((r: any) => normalize(kind, { ...r.data, id: String(r.id) }));

  let ids: string[] | null = null;
  if (since) {
    ids = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from(table)
        .select('id')
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      ids.push(...(data || []).map((r: any) => String(r.id)));
      if (!data || data.length < PAGE) break;
    }
  }
  return { items, ids };
}

async function fetchLogs(afterSeq: number): Promise<{ logs: ReviewLog[]; lastSeq: number }> {
  const logs: ReviewLog[] = [];
  let cursor = Math.max(0, afterSeq);
  for (;;) {
    const { data, error } = await supabase
      .from('review_logs')
      .select('seq,data')
      .gt('seq', cursor)
      .order('seq', { ascending: true })
      .limit(MAX_LOGS_PER_PUSH);
    if (error) throw error;
    const rows = data || [];
    logs.push(...rows.map((r: any) => r.data).filter(Boolean));
    if (rows.length === 0) break;
    cursor = Math.max(cursor, ...rows.map((r: any) => Number(r.seq) || 0));
    if (rows.length < MAX_LOGS_PER_PUSH) break;
  }
  return { logs, lastSeq: cursor };
}

async function fetchVersion(): Promise<{ version: string; cursors: Record<ItemKind, string> }> {
  const tables = ['vocab_items', 'grammar_items', 'user_settings'] as const;
  const stats = async (table: (typeof tables)[number]) => {
    const countColumn = table === 'user_settings' ? 'key' : 'id';
    const { count, error: countError } = await supabase
      .from(table)
      .select(countColumn, { count: 'exact', head: true });
    if (countError) throw countError;

    const { data, error } = await supabase
      .from(table)
      .select('updated_at')
      .order('updated_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    return { count: count || 0, max: data?.[0]?.updated_at || '' };
  };

  const [vocab, grammar, settings] = await Promise.all(tables.map(stats));
  const { data: logRows, error: logError } = await supabase
    .from('review_logs')
    .select('seq')
    .order('seq', { ascending: false })
    .limit(1);
  if (logError) throw logError;
  const logs = Number(logRows?.[0]?.seq) || 0;

  return {
    version: [vocab.count, vocab.max, grammar.count, grammar.max, settings.count, settings.max, logs].join('|'),
    cursors: { vocab: vocab.max, grammar: grammar.max },
  };
}

async function postChanges(body: Partial<Changes>): Promise<void> {
  const userId = await currentUserId();

  for (const kind of ['vocab', 'grammar'] as ItemKind[]) {
    const table = kind === 'vocab' ? 'vocab_items' : 'grammar_items';
    const upserts = (body.upserts?.[kind] || []).filter((item) => item && item.id != null);
    const deletes = (body.deletes?.[kind] || []).map(String);

    if (upserts.length) {
      const rows = upserts.map((item) => ({
        user_id: userId,
        id: String(item.id),
        data: item,
        updated_at: new Date().toISOString(),
      }));
      const { error } = await supabase.from(table).upsert(rows, { onConflict: 'user_id,id' });
      if (error) throw error;
    }
    if (deletes.length) {
      const { error } = await supabase.from(table).delete().in('id', deletes);
      if (error) throw error;
    }
  }

  if (body.settings && Object.keys(body.settings).length) {
    const entries = Object.entries(body.settings);
    const toUpsert = entries
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, data]) => ({ user_id: userId, key, data, updated_at: new Date().toISOString() }));
    const toDelete = entries.filter(([, value]) => value == null).map(([key]) => key);

    if (toUpsert.length) {
      const { error } = await supabase.from('user_settings').upsert(toUpsert, { onConflict: 'user_id,key' });
      if (error) throw error;
    }
    if (toDelete.length) {
      const { error } = await supabase.from('user_settings').delete().in('key', toDelete);
      if (error) throw error;
    }
  }

  if (body.logs?.length) {
    const rows = body.logs
      .filter((l) => l && typeof l.timestamp === 'string')
      .map((l) => ({
        user_id: userId,
        id: reviewLogId(l),
        ts: l.timestamp,
        data: l,
      }));
    if (rows.length) {
      const { error } = await supabase.from('review_logs').upsert(rows, {
        onConflict: 'user_id,id',
        ignoreDuplicates: true,
      });
      if (error) throw error;
    }
  }
}

async function getJson(query: string): Promise<any> {
  const params = new URLSearchParams(query);
  const kind = params.get('kind');

  if (kind === 'settings') {
    const { data, error } = await supabase.from('user_settings').select('key,data').order('key');
    if (error) throw error;
    const settings: Record<string, unknown> = {};
    (data || []).forEach((row: any) => { settings[row.key] = row.data; });
    return { success: true, settings };
  }

  if (kind === 'version') return { success: true, ...(await fetchVersion()) };

  if (kind === 'vocab' || kind === 'grammar') return { success: true, ...(await fetchItems(kind)) };

  if (kind === 'logs') {
    const result = await fetchLogs(Number(params.get('afterSeq')) || 0);
    return { success: true, logs: result.logs, lastSeq: result.lastSeq, nextSeq: null };
  }

  throw new Error(`Unknown sync query: ${kind}`);
}

// ---------------------------------------------------------------------------
// Diff & push
// ---------------------------------------------------------------------------

interface Changes {
  upserts: Record<ItemKind, AnyItem[]>;
  deletes: Record<ItemKind, string[]>;
  settings: Record<string, string | null>;
  logs: ReviewLog[];
}

const emptyChanges = (): Changes => ({
  upserts: { vocab: [], grammar: [] },
  deletes: { vocab: [], grammar: [] },
  settings: {},
  logs: [],
});

function diffItems(items: Array<{ id: string }>, base: Record<string, string>) {
  const current = new Set<string>();
  const upserts = items.filter((item) => {
    current.add(item.id);
    return base[item.id] !== hashItem(item);
  });
  const deletes = Object.keys(base).filter((id) => !current.has(id));
  return { upserts, deletes };
}

function computeChanges(state: SyncState, vocab: VocabItem[], grammar: GrammarItem[]): Changes {
  const v = diffItems(vocab, state.vocab);
  const g = diffItems(grammar, state.grammar);
  const localSettings = readSyncedSettings();
  const settings: Record<string, string | null> = {};
  for (const key of SYNCED_SETTING_KEYS) {
    const value = localSettings[key] ?? null;
    if (value !== (state.settings[key] ?? null)) settings[key] = value;
  }
  const logs = getReviewLogs().filter((l) => l.timestamp > state.logsPushedThrough);
  return {
    upserts: { vocab: v.upserts as AnyItem[], grammar: g.upserts as AnyItem[] },
    deletes: { vocab: v.deletes, grammar: g.deletes },
    settings,
    logs,
  };
}

function countChanges(c: Changes): number {
  return (
    c.upserts.vocab.length +
    c.upserts.grammar.length +
    c.deletes.vocab.length +
    c.deletes.grammar.length +
    c.logs.length +
    Object.keys(c.settings).length
  );
}

/**
 * Gửi thay đổi theo từng gói nhỏ; sau mỗi gói thành công thì cập nhật ảnh chụp
 * (nếu có), nên nếu mất mạng giữa chừng lần sau chỉ gửi phần còn lại.
 */
async function pushChangesInBatches(changes: Changes, onBatch?: (part: Partial<Changes>) => void): Promise<void> {
  // 1) Deletes + settings (small)
  if (changes.deletes.vocab.length || changes.deletes.grammar.length || Object.keys(changes.settings).length) {
    await postChanges({ deletes: changes.deletes, settings: changes.settings });
    onBatch?.({ deletes: changes.deletes, settings: changes.settings });
  }

  // 2) Upserts, split by payload size
  for (const kind of ['vocab', 'grammar'] as ItemKind[]) {
    let batch: AnyItem[] = [];
    let bytes = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      await postChanges({ upserts: { [kind]: batch } });
      onBatch?.({ upserts: { ...emptyChanges().upserts, [kind]: batch } });
      batch = [];
      bytes = 0;
    };
    for (const item of changes.upserts[kind]) {
      const size = JSON.stringify(item).length;
      if (batch.length > 0 && bytes + size > MAX_PUSH_BYTES) await flush();
      batch.push(item);
      bytes += size;
    }
    await flush();
  }

  // 3) Review logs (append-only)
  const logs = [...changes.logs].sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  for (let i = 0; i < logs.length; i += MAX_LOGS_PER_PUSH) {
    const chunk = logs.slice(i, i + MAX_LOGS_PER_PUSH);
    await postChanges({ logs: chunk });
    onBatch?.({ logs: chunk });
  }
}

/** Gửi thay đổi và ghi nhận vào ảnh chụp sau mỗi gói thành công */
function pushWithState(userId: string, state: SyncState, changes: Changes): Promise<void> {
  return pushChangesInBatches(changes, (part) => {
    part.deletes?.vocab.forEach((id) => delete state.vocab[id]);
    part.deletes?.grammar.forEach((id) => delete state.grammar[id]);
    Object.entries(part.settings || {}).forEach(([key, value]) => {
      state.settings[key] = value;
    });
    (['vocab', 'grammar'] as ItemKind[]).forEach((kind) =>
      part.upserts?.[kind].forEach((item) => {
        state[kind][item.id] = hashItem(item);
      })
    );
    const last = part.logs?.[part.logs.length - 1]?.timestamp;
    if (last && last > state.logsPushedThrough) state.logsPushedThrough = last;
    saveSyncState(userId, state);
  });
}

// ---------------------------------------------------------------------------
// Thay đổi giữ lại khi đăng xuất lúc chưa gửi được (chỉ tài khoản đó dùng lại)
// ---------------------------------------------------------------------------

function loadStash(userId: string): Changes | null {
  try {
    const raw = localStorage.getItem(PENDING_STASH_PREFIX + userId);
    if (!raw) return null;
    return { ...emptyChanges(), ...JSON.parse(raw) };
  } catch {
    return null;
  }
}

/** Gửi phần thay đổi đã giữ lại từ lần đăng xuất trước (nếu có). */
async function flushStash(userId: string): Promise<void> {
  const stash = loadStash(userId);
  if (!stash) return;
  await pushChangesInBatches(stash);
  safeRemove(PENDING_STASH_PREFIX + userId);
}

const stashCount = (userId: string) => {
  const stash = loadStash(userId);
  return stash ? countChanges(stash) : 0;
};

// ---------------------------------------------------------------------------
// Gộp dữ liệu tài khoản với dữ liệu trên máy
// ---------------------------------------------------------------------------

/**
 * Áp các thẻ vừa đổi trên tài khoản (`changed`) lên danh sách trên máy.
 * - Thẻ đã sửa trên máy kể từ lần đồng bộ trước (chưa gửi) được giữ, sẽ được gửi lên.
 * - `allIds` = mọi id tài khoản đang có; thẻ đã đồng bộ mà không còn trong đó là
 *   đã bị xóa ở thiết bị khác.
 * - Chưa có ảnh chụp (lần đầu trên máy này): giữ thẻ chỉ có trên máy; thẻ có ở cả
 *   hai thì giữ bản đã được ôn gần hơn.
 */
function mergeKind<T extends AnyItem>(
  local: T[],
  base: Record<string, string> | null,
  changed: T[],
  allIds: Set<string>
): { list: T[]; hashes: Record<string, string> } {
  const hashes: Record<string, string> = base ? { ...base } : {};
  const localById = new Map(local.map((item) => [item.id, item]));
  const changedById = new Map(changed.map((item) => [item.id, item]));
  const editedLocally = (id: string): boolean => {
    const mine = localById.get(id);
    if (base) return (base[id] ?? null) !== (mine ? hashItem(mine) : null);
    const theirs = changedById.get(id);
    return !!mine && !!theirs && progressKey(mine) > progressKey(theirs);
  };

  const replaced = new Map<string, T>();
  const fromOtherDevices: T[] = [];
  for (const item of changed) {
    hashes[item.id] = hashItem(item);
    if (editedLocally(item.id)) continue;
    const mine = localById.get(item.id);
    if (mine) {
      if (hashItem(mine) !== hashes[item.id]) replaced.set(item.id, item);
    }
    else if (!base || !(item.id in base)) fromOtherDevices.push(item);
  }

  const removed = new Set<string>();
  for (const id of new Set([...Object.keys(hashes), ...localById.keys()])) {
    if (allIds.has(id)) continue;
    const wasSynced = !!base && id in base;
    if (wasSynced && !editedLocally(id)) removed.add(id);
    delete hashes[id];
  }

  fromOtherDevices.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const kept = local.filter((item) => !removed.has(item.id)).map((item) => replaced.get(item.id) ?? item);
  return { list: [...fromOtherDevices, ...kept], hashes };
}

/** Cài đặt từ tài khoản thắng, trừ khi trên máy vừa đổi mà chưa gửi. Trả về true nếu có ghi. */
function mergeSettings(state: SyncState | null, cloudSettings: Record<string, unknown>): {
  changed: boolean;
  cloudRaw: Record<string, string | null>;
} {
  const localSettings = readSyncedSettings();
  const toWrite: Record<string, string | null> = {};
  const cloudRaw: Record<string, string | null> = {};
  for (const key of SYNCED_SETTING_KEYS) {
    const cloudValue = typeof cloudSettings[key] === 'string' ? (cloudSettings[key] as string) : null;
    cloudRaw[key] = cloudValue;
    const localValue = localSettings[key] ?? null;
    const localEdited = state ? localValue !== (state.settings[key] ?? null) : false;
    if (localEdited) continue; // thay đổi trên máy chưa gửi → giữ, sẽ được gửi lên
    if (cloudValue !== null && cloudValue !== localValue) toWrite[key] = cloudValue;
    else if (cloudValue === null && state && localValue !== null) toWrite[key] = null; // đã xóa ở thiết bị khác
  }
  const changed = Object.keys(toWrite).length > 0;
  if (changed) writeSyncedSettings(toWrite);
  return { changed, cloudRaw };
}

// ---------------------------------------------------------------------------
// Chuyển dữ liệu từ các bảng Supabase cũ (một lần cho mỗi tài khoản)
// ---------------------------------------------------------------------------

const MISSING_TABLE = /PGRST205|42P01|does not exist|Could not find the table/i;

async function readSupabaseLegacy(userId: string): Promise<{ vocab: AnyItem[]; grammar: AnyItem[] } | null> {
  const out: { vocab: Map<string, AnyItem>; grammar: Map<string, AnyItem> } = { vocab: new Map(), grammar: new Map() };

  const { data: study, error: studyError } = await supabase
    .from('study_data')
    .select('vocab,grammar')
    .eq('user_id', userId)
    .maybeSingle();
  if (studyError && !MISSING_TABLE.test(`${studyError.code} ${studyError.message}`)) return null;
  for (const kind of ['vocab', 'grammar'] as ItemKind[]) {
    const list = Array.isArray((study as any)?.[kind]) ? ((study as any)[kind] as any[]) : [];
    list.filter((item) => item && item.id != null).forEach((item) => out[kind].set(String(item.id), normalize(kind, { ...item, id: String(item.id) })));
  }

  for (const kind of ['vocab', 'grammar'] as ItemKind[]) {
    for (let from = 0; ; from += SUPABASE_PAGE_SIZE) {
      const { data, error } = await supabase
        .from(`${kind}_items`)
        .select('id,data')
        .eq('user_id', userId)
        .order('id', { ascending: true })
        .range(from, from + SUPABASE_PAGE_SIZE - 1);
      if (error) {
        if (MISSING_TABLE.test(`${error.code} ${error.message}`)) break;
        return null;
      }
      (data || []).forEach((row: any) => {
        if (!row?.data) return;
        const item = normalize(kind, { ...row.data, id: String(row.id) });
        const existing = out[kind].get(item.id);
        if (!existing || progressKey(item) >= progressKey(existing)) out[kind].set(item.id, item);
      });
      if (!data || data.length < SUPABASE_PAGE_SIZE) break;
    }
  }
  return { vocab: [...out.vocab.values()], grammar: [...out.grammar.values()] };
}

/** Thêm thẻ cũ chưa có; thẻ đã có thì giữ bản được ôn gần hơn */
function absorbLegacy<T extends AnyItem>(list: T[], legacy: T[]): T[] {
  if (legacy.length === 0) return list;
  const index = new Map(list.map((item, i) => [item.id, i]));
  const next = [...list];
  const added: T[] = [];
  for (const item of legacy) {
    const i = index.get(item.id);
    if (i === undefined) added.push(item);
    else if (progressKey(item) > progressKey(next[i])) next[i] = item;
  }
  return [...next, ...added];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let chain: Promise<unknown> = Promise.resolve();

/** Xếp hàng các lượt đồng bộ để không bao giờ chạy chồng lên nhau */
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.catch(() => undefined);
  return run;
}

async function tracked<T>(task: () => Promise<T>): Promise<T> {
  setStatus({ syncing: true });
  try {
    const result = await task();
    noteResult(null);
    return result;
  } catch (err) {
    noteResult(err);
    throw err;
  } finally {
    setStatus({ syncing: false });
  }
}

/** Số thay đổi trên máy chưa có trong tài khoản (cập nhật luôn trạng thái hiển thị). */
export function countPendingChanges(userId: string, vocab: VocabItem[], grammar: GrammarItem[]): number {
  const state = loadSyncState(userId);
  const pending = (state ? countChanges(computeChanges(state, vocab, grammar)) : 0) + stashCount(userId);
  setStatus({ pending });
  return pending;
}

/**
 * Gửi mọi thay đổi trên máy (từ vựng, ngữ pháp, cài đặt, Rank, lịch sử ôn) lên tài khoản.
 * Trả về false nếu chưa đồng bộ lần đầu trên máy này.
 */
export function pushLocalChanges(userId: string, getLists: GetLists): Promise<boolean> {
  return serialize(async () => {
    const state = loadSyncState(userId);
    if (!state || getDataOwner() !== userId) return false;
    try {
      await tracked(async () => {
        await flushStash(userId);
        const { vocab, grammar } = getLists();
        const changes = computeChanges(state, vocab, grammar);
        if (countChanges(changes) > 0) await pushWithState(userId, state, changes);
      });
    } finally {
      const { vocab, grammar } = getLists();
      countPendingChanges(userId, vocab, grammar);
    }
    return true;
  });
}

/**
 * Tải toàn bộ dữ liệu của tài khoản khi mở app / đăng nhập, gộp với thay đổi trên
 * máy chưa kịp gửi, rồi gửi phần chênh lệch lên. Lần đầu (sau khi cập nhật) còn
 * chuyển dữ liệu từ các bảng Supabase cũ và bản lưu trên máy vào tài khoản.
 */
export function pullAndMerge(userId: string, getLists: GetLists): Promise<SyncedData> {
  return serialize(() =>
    tracked(async () => {
      await flushStash(userId).catch((err) => console.warn('Chưa gửi được thay đổi đã giữ lại:', err));

      const [version, cloudVocab, cloudGrammar, settingsJson] = await Promise.all([
        fetchVersion(),
        fetchItems('vocab'),
        fetchItems('grammar'),
        getJson('kind=settings'),
      ]);
      const cloudSettings: Record<string, unknown> = settingsJson.settings || {};

      const owner = getDataOwner();
      // Bản sao trên máy thuộc tài khoản khác → bỏ đi, không trộn vào tài khoản này
      const foreign = !!owner && owner !== userId;
      if (foreign) await clearLocalCopy();
      const base = owner === userId ? loadSyncState(userId) : null;

      // Dữ liệu cũ trong Supabase: chỉ đọc 1 lần cho mỗi tài khoản
      const needsSupabase = cloudSettings[SUPABASE_MIGRATED_KEY] == null;
      const legacy = needsSupabase ? await readSupabaseLegacy(userId).catch(() => null) : null;

      const { vocab: localVocab, grammar: localGrammar } = foreign ? { vocab: [], grammar: [] } : getLists();
      const v = mergeKind<VocabItem>(localVocab, base?.vocab ?? null, cloudVocab.items as VocabItem[], new Set(cloudVocab.items.map((i) => i.id)));
      const g = mergeKind<GrammarItem>(localGrammar, base?.grammar ?? null, cloudGrammar.items as GrammarItem[], new Set(cloudGrammar.items.map((i) => i.id)));
      const vocab = absorbLegacy(v.list, (legacy?.vocab || []) as VocabItem[]);
      const grammar = absorbLegacy(g.list, (legacy?.grammar || []) as GrammarItem[]);

      const settings = mergeSettings(base, cloudSettings);

      // --- Lịch sử ôn tập ---
      const { logs: cloudLogs, lastSeq } = await fetchLogs(base?.logsSeq ?? 0);
      const basePushedThrough = base?.logsPushedThrough ?? '';
      const cloudLogIds = new Set(cloudLogs.map(reviewLogId));
      // Lượt ôn trên máy chưa có trong tài khoản (lần đầu: toàn bộ lịch sử cũ trên máy)
      const pendingLogs = getReviewLogs().filter(
        (l) => (base ? l.timestamp > basePushedThrough : true) && !cloudLogIds.has(reviewLogId(l))
      );
      const logsChanged = mergeReviewLogs(cloudLogs) > 0;

      // Ảnh chụp = những gì tài khoản đang có; phần chênh lệch được gửi ngay sau đây
      const state: SyncState = {
        vocab: v.hashes,
        grammar: g.hashes,
        settings: settings.cloudRaw,
        logsPushedThrough: basePushedThrough,
        logsSeq: lastSeq,
        version: version.version,
        cursors: version.cursors,
      };
      setDataOwner(userId);
      saveSyncState(userId, state);

      try {
        const changes = { ...computeChanges(state, vocab, grammar), logs: pendingLogs };
        if (countChanges(changes) > 0) await pushWithState(userId, state, changes);
        const allLogs = getReviewLogs();
        const newest = allLogs.length ? allLogs[allLogs.length - 1].timestamp : '';
        if (newest > state.logsPushedThrough) {
          state.logsPushedThrough = newest;
          saveSyncState(userId, state);
        }
        if (needsSupabase && legacy) {
          await postChanges({
            settings: {
              [SUPABASE_MIGRATED_KEY]: JSON.stringify({
                at: new Date().toISOString(),
                vocab: legacy.vocab.length,
                grammar: legacy.grammar.length,
              }),
            },
          });
        }
      } catch (err) {
        // Dữ liệu vẫn an toàn trên máy; lần đồng bộ sau sẽ gửi tiếp phần còn thiếu
        console.warn('Chưa gửi được thay đổi lên tài khoản:', err);
      }

      countPendingChanges(userId, vocab, grammar);
      return { vocab, grammar, settingsChanged: settings.changed, logsChanged };
    })
  );
}

/**
 * Kiểm tra nhẹ xem tài khoản có thay đổi từ thiết bị khác không; nếu có thì chỉ tải
 * phần đã đổi và gộp vào. Trả về null khi không có gì mới.
 */
export function pullRemoteChanges(userId: string, getLists: GetLists): Promise<SyncedData | null> {
  return serialize(() =>
    tracked(async () => {
      const state = loadSyncState(userId);
      if (!state || getDataOwner() !== userId) return null;

      const version = await fetchVersion();
      if (version.version === state.version) return null;

      const [vocabChanges, grammarChanges, settingsJson, logResult] = await Promise.all([
        fetchItems('vocab', state.cursors.vocab),
        fetchItems('grammar', state.cursors.grammar),
        getJson('kind=settings'),
        fetchLogs(state.logsSeq),
      ]);

      // Gộp trên danh sách MỚI NHẤT (người dùng có thể vừa ôn thêm trong lúc tải)
      const { vocab: localVocab, grammar: localGrammar } = getLists();
      // Không có mốc `since` → máy chủ trả về toàn bộ thẻ, nên đó cũng là danh sách id đầy đủ
      const allVocab = new Set(vocabChanges.ids ?? vocabChanges.items.map((i) => i.id));
      const allGrammar = new Set(grammarChanges.ids ?? grammarChanges.items.map((i) => i.id));
      const v = mergeKind<VocabItem>(localVocab, state.vocab, vocabChanges.items as VocabItem[], allVocab);
      const g = mergeKind<GrammarItem>(localGrammar, state.grammar, grammarChanges.items as GrammarItem[], allGrammar);
      const settings = mergeSettings(state, settingsJson.settings || {});
      const logsChanged = mergeReviewLogs(logResult.logs) > 0;

      const next: SyncState = {
        ...state,
        vocab: v.hashes,
        grammar: g.hashes,
        settings: settings.cloudRaw,
        logsSeq: logResult.lastSeq,
        version: version.version,
        cursors: version.cursors,
      };
      saveSyncState(userId, next);
      countPendingChanges(userId, v.list, g.list);

      const listsChanged = v.list.some((item, i) => item !== localVocab[i]) || v.list.length !== localVocab.length ||
        g.list.some((item, i) => item !== localGrammar[i]) || g.list.length !== localGrammar.length;
      if (!listsChanged && !settings.changed && !logsChanged) return null;
      return { vocab: v.list, grammar: g.list, settingsChanged: settings.changed, logsChanged };
    })
  );
}

/**
 * Chuẩn bị đăng xuất: cố gửi hết thay đổi (tối đa `timeoutMs`). Trả về số thay đổi
 * vẫn chưa gửi được để app cảnh báo người dùng.
 */
export async function flushBeforeSignOut(userId: string, getLists: GetLists, timeoutMs = 8000): Promise<number> {
  await Promise.race([
    pushLocalChanges(userId, getLists).catch(() => false),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  const { vocab, grammar } = getLists();
  return countPendingChanges(userId, vocab, grammar);
}

/** Máy này đã từng đồng bộ với tài khoản (có ảnh chụp để biết thay đổi nào chưa gửi). */
export function hasSyncBase(userId: string): boolean {
  return !!loadSyncState(userId) && getDataOwner() === userId;
}

/**
 * Đăng xuất khi còn thay đổi chưa gửi: giữ riêng các thay đổi đó (chỉ gửi lại khi đúng
 * tài khoản này đăng nhập). Trả về false nếu không giữ lại được (vd. bộ nhớ đầy).
 */
export function stashPendingChanges(userId: string, getLists: GetLists): boolean {
  const state = loadSyncState(userId);
  if (!state || getDataOwner() !== userId) return true;
  const { vocab, grammar } = getLists();
  const changes = computeChanges(state, vocab, grammar);
  if (countChanges(changes) === 0) return true;
  const previous = loadStash(userId);
  if (previous) {
    // Gộp với phần đã giữ từ trước: thay đổi mới hơn ghi đè
    (['vocab', 'grammar'] as ItemKind[]).forEach((kind) => {
      const ids = new Set([...changes.upserts[kind].map((i) => i.id), ...changes.deletes[kind]]);
      changes.upserts[kind] = [...previous.upserts[kind].filter((i) => !ids.has(i.id)), ...changes.upserts[kind]];
      changes.deletes[kind] = [...previous.deletes[kind].filter((id) => !ids.has(id)), ...changes.deletes[kind]];
    });
    changes.settings = { ...previous.settings, ...changes.settings };
    changes.logs = [...previous.logs, ...changes.logs];
  }
  try {
    localStorage.setItem(PENDING_STASH_PREFIX + userId, JSON.stringify(changes));
    return true;
  } catch (err) {
    console.warn('Không giữ lại được thay đổi chưa gửi:', err);
    return false;
  }
}
