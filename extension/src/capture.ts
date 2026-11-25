import type { CapturePayload } from '../../shared/types'

export type FrameText = { url: string; text: string }

const PNG_PREFIX = 'data:image/png;base64,'
const MAX_FRAME_CHARS = 50_000

// The screenshot is required; page text is best-effort (restricted pages and canvas apps give none).
export function buildPayload(tab: { url?: string; title?: string }, dataUrl: string, frames: FrameText[]): CapturePayload {
  if (!dataUrl.startsWith(PNG_PREFIX)) throw new Error('screenshot is not a png data url')
  const text = frames
    .filter((f) => f.text !== '')
    .map((f) => `## frame: ${f.url}\n${f.text.slice(0, MAX_FRAME_CHARS)}`)
    .join('\n\n')
  return { url: tab.url ?? '', title: tab.title ?? '', text, png: dataUrl.slice(PNG_PREFIX.length) }
}
