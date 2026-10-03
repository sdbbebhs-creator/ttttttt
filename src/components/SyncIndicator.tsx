import React from 'react';
import { CloudOff, CloudUpload, Cloud, Loader2 } from 'lucide-react';
import { useSyncStatus } from '../hooks/useSyncStatus';

/** Góc trên: cho biết dữ liệu đã nằm an toàn trong tài khoản hay còn đang chờ gửi. */
export const SyncIndicator: React.FC = () => {
  const { online, pending, syncing, networkError } = useSyncStatus();
  const waitingForNetwork = !online || networkError;

  const base =
    'inline-flex items-center gap-1.5 h-9 px-2.5 rounded-xl text-xs font-semibold ring-1 ring-inset shrink-0 select-none';

  if (waitingForNetwork) {
    return (
      <span
        role="status"
        className={`${base} bg-amber-500/10 ring-amber-500/30 text-amber-800 dark:text-amber-200`}
        title={
          pending > 0
            ? `Đang chờ mạng — ${pending} thay đổi được giữ trên máy và sẽ tự gửi lên tài khoản khi có mạng lại.`
            : 'Đang chờ mạng — thay đổi mới sẽ được giữ trên máy và tự gửi khi có mạng lại.'
        }
      >
        <CloudOff size={15} className="shrink-0" />
        <span className="hidden sm:inline">Đang chờ mạng</span>
        {pending > 0 && (
          <span className="tabular-nums min-w-5 h-5 px-1.5 inline-flex items-center justify-center rounded-full bg-amber-500 text-white text-[11px] font-bold">
            {pending > 999 ? '999+' : pending}
          </span>
        )}
      </span>
    );
  }

  if (syncing || pending > 0) {
    return (
      <span
        role="status"
        className={`${base} bg-white dark:bg-slate-900 ring-slate-200 dark:ring-slate-800 text-slate-600 dark:text-slate-300`}
        title={pending > 0 ? `Đang lưu ${pending} thay đổi vào tài khoản…` : 'Đang đồng bộ với tài khoản…'}
      >
        {syncing ? <Loader2 size={15} className="animate-spin shrink-0" /> : <CloudUpload size={15} className="shrink-0" />}
        <span className="hidden lg:inline">Đang lưu</span>
        {pending > 0 && <span className="tabular-nums">{pending}</span>}
      </span>
    );
  }

  return (
    <span
      role="status"
      className={`${base} bg-white dark:bg-slate-900 ring-slate-200 dark:ring-slate-800 text-emerald-600 dark:text-emerald-400`}
      title="Đã lưu vào tài khoản — đăng nhập ở thiết bị nào cũng thấy cùng dữ liệu."
    >
      <Cloud size={15} className="shrink-0" />
      <span className="hidden lg:inline">Đã lưu</span>
    </span>
  );
};
