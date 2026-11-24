/** Formatting for figures: one format per kind across the dashboard (tabular figures in CSS). */

/** 12.0 s, 1 min 05 s, 1 h 02 min. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '–';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const totalSeconds = Math.round(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  if (m < 60) return `${m} min ${String(totalSeconds % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** Time between two ISO times, or from `from` until now. */
export function between(from?: string, to?: string, now = Date.now()): string {
  if (!from) return '–';
  const end = to ? Date.parse(to) : now;
  return duration(end - Date.parse(from));
}

/** "just now", "4 min ago", "3 h ago", then the date. */
export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '–';
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return '–';
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return dateTime(iso);
}

const DATE_TIME = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** 23 Nov 2026, 14:02 (local time). */
export function dateTime(iso: string | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '–' : DATE_TIME.format(d);
}

/** 14:02:11 (local time). */
export function clock(d: Date): string {
  return TIME.format(d);
}

/** 0..1 -> "42 %". */
export function percent(fraction: number | undefined): string {
  const f = Math.min(1, Math.max(0, fraction ?? 0));
  return `${Math.floor(f * 100)} %`;
}

/** 1080 × 1920. */
export function size(w: number, h: number): string {
  return `${w} × ${h}`;
}

/** 1 234 567 -> "1.2 MB". */
export function bytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '–';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** render -> "Render", render_unit -> "Render unit". */
export function jobType(type: string): string {
  const t = type.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Scopes as people read them: "read only", "read, render". */
export function scopeText(scopes: string[]): string {
  if (scopes.includes('admin')) return 'admin';
  if (scopes.length === 1 && scopes[0] === 'read') return 'read only';
  return scopes.join(', ');
}

const CODEC_LABEL: Record<string, string> = {
  h264: 'H.264',
  'prores-422-hq': 'ProRes 422 HQ',
  'prores-4444': 'ProRes 4444',
  vp9: 'VP9',
  av1: 'AV1',
  gif: 'GIF',
  aac: 'AAC',
  'pcm-s16le': 'PCM',
};

/** "MP4 · H.264", "MOV · ProRes 4444 · alpha", "PNG sequence · PNG frames · alpha" (#302; renders before it are MP4). */
export function outputFormat(r: { format?: string; codec?: string; alpha?: boolean }): string {
  const format = r.format ?? 'mp4';
  const name = format === 'png-sequence' ? 'PNG sequence' : format === 'webm' ? 'WebM' : format.toUpperCase();
  const codec = CODEC_LABEL[r.codec ?? 'h264'] ?? r.codec ?? '';
  // GIF and PNG sequences have one codec each: naming it again says nothing.
  const sameAsFormat = format === 'gif' || format === 'png-sequence';
  return [name, sameAsFormat ? '' : codec, r.alpha ? 'alpha' : ''].filter(Boolean).join(' · ');
}

/** The container alone, for cards: "MP4", "MOV · alpha", "PNG frames". */
export function outputShort(r: { format?: string; alpha?: boolean }): string {
  const format = r.format ?? 'mp4';
  const name = format === 'png-sequence' ? 'PNG frames' : format === 'webm' ? 'WebM' : format.toUpperCase();
  return r.alpha ? `${name} · alpha` : name;
}

/**
 * How the render page shows a format's file: a video player (MP4, WebM), the
 * GIF itself, an audio player, or the first frame as a still where a browser
 * cannot play the file (ProRes MOV) or there is no single file to play (PNG zip).
 */
export function playerKind(format: string | undefined): 'video' | 'image' | 'audio' | 'still' {
  if (format === 'gif') return 'image';
  if (format === 'm4a' || format === 'wav') return 'audio';
  if (format === 'png-sequence' || format === 'mov') return 'still';
  return 'video';
}

/** The caption under a still. */
export function stillNote(format: string | undefined): string | null {
  if (format === 'mov') return 'ProRes plays in editing apps, not in browsers. This is the middle frame';
  if (format === 'png-sequence') return 'Every frame is a PNG in the zip. This is the middle one';
  return null;
}

/** The download button: "Download MP4", "Download frames (ZIP)". */
export function downloadLabel(file: string): string {
  const ext = file.slice(file.lastIndexOf('.') + 1).toUpperCase();
  return ext === 'ZIP' ? 'Download frames (ZIP)' : `Download ${ext === 'WEBM' ? 'WebM' : ext}`;
}
