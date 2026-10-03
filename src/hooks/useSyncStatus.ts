import { useSyncExternalStore } from 'react';
import { getSyncStatus, subscribeSyncStatus, type SyncStatus } from '../utils/syncClient';

/** Trạng thái đồng bộ tài khoản (mất mạng, số thay đổi đang chờ, đang lưu). */
export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(subscribeSyncStatus, getSyncStatus, getSyncStatus);
}
