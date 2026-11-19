/** Seconds as m:ss.s, for showing a position in a video. */
export function clock(seconds) {
  if (!Number.isFinite(seconds)) return '0:00.0';
  const tenths = Math.round(seconds * 10);
  const s = (tenths % 600) / 10;
  const m = Math.floor(tenths / 600);
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}

/** File size in MB or GB. */
export function fileSize(bytes) {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(mb))} MB`;
}
