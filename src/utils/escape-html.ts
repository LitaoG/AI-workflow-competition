/**
 * Escape a string for safe text interpolation into HTML documents.
 * Single home for the identical helpers that used to live in dwf/live.ts
 * and visualizer/studio-renderer.ts.
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
