/**
 * Thin wrapper over the Fullscreen API with the `webkit`-prefixed fallback some
 * mobile browsers still need. `requestFullscreen` only works inside a user
 * gesture, so callers must invoke enter/toggle from a tap/click handler.
 */
type FsElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};
type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

const swallow = (p: Promise<void> | void): void => {
  if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => {});
};

export function isFullscreen(): boolean {
  const d = document as FsDocument;
  return !!(d.fullscreenElement || d.webkitFullscreenElement);
}

/** Request fullscreen on the whole document. No-op if already fullscreen. */
export function enterFullscreen(): void {
  if (isFullscreen()) return;
  const el = document.documentElement as FsElement;
  try {
    swallow(el.requestFullscreen ? el.requestFullscreen() : el.webkitRequestFullscreen?.());
  } catch {
    /* denied / unsupported (e.g. iOS Safari on non-video) — fine */
  }
}

export function exitFullscreen(): void {
  if (!isFullscreen()) return;
  const d = document as FsDocument;
  try {
    swallow(d.exitFullscreen ? d.exitFullscreen() : d.webkitExitFullscreen?.());
  } catch {
    /* ignore */
  }
}

export function toggleFullscreen(): void {
  if (isFullscreen()) exitFullscreen();
  else enterFullscreen();
}

/** Subscribe to enter/exit fullscreen; returns an unsubscribe fn. */
export function onFullscreenChange(cb: () => void): () => void {
  document.addEventListener('fullscreenchange', cb);
  document.addEventListener('webkitfullscreenchange', cb);
  return () => {
    document.removeEventListener('fullscreenchange', cb);
    document.removeEventListener('webkitfullscreenchange', cb);
  };
}
