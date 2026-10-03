/** Sinh UUID duy nhất cho thẻ mới (fallback cho trình duyệt rất cũ). */
export function newItemId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Đảm bảo mọi thẻ đều có id; thẻ thiếu id được gán UUID mới. */
export function withItemId<T extends { id?: string }>(item: T): T & { id: string } {
  return { ...item, id: item.id || newItemId() };
}
