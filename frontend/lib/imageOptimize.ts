export type OptimizeImageOptions = {
  width?: number
  height?: number
  quality?: number
  /**
   * Generic intent. This is mapped to provider-specific modes.
   * - Supabase: resize=cover|contain
   * - Cloudinary: c_fill|c_fit
   */
  resize?: 'cover' | 'contain'
}

const isProbablyHttpUrl = (s: string) => /^https?:\/\//i.test(s)

const clampInt = (v: number, min: number, max: number) => {
  const n = Math.round(v)
  return Math.max(min, Math.min(max, n))
}

const tryOptimizeSupabaseStoragePublicObjectUrl = (input: string, opts: OptimizeImageOptions): string | null => {
  // Supabase Storage public object URL:
  //   https://<project>.supabase.co/storage/v1/object/public/<bucket>/<path>
  // Render (resized) URL:
  //   https://<project>.supabase.co/storage/v1/render/image/public/<bucket>/<path>?width=...&height=...&resize=cover&quality=...
  try {
    const url = new URL(input)
    const marker = '/storage/v1/object/public/'
    const idx = url.pathname.indexOf(marker)
    if (idx < 0) return null

    const rest = url.pathname.slice(idx + marker.length) // <bucket>/<path>
    url.pathname = url.pathname.slice(0, idx) + `/storage/v1/render/image/public/${rest}`

    if (opts.width && Number.isFinite(opts.width)) url.searchParams.set('width', String(clampInt(opts.width, 16, 4096)))
    if (opts.height && Number.isFinite(opts.height)) url.searchParams.set('height', String(clampInt(opts.height, 16, 4096)))
    if (opts.quality && Number.isFinite(opts.quality)) url.searchParams.set('quality', String(clampInt(opts.quality, 20, 95)))
    if (opts.resize) url.searchParams.set('resize', opts.resize)

    return url.toString()
  } catch {
    return null
  }
}

const looksLikeCloudinaryImageUploadUrl = (input: string): boolean => {
  // Typical: https://res.cloudinary.com/<cloud>/image/upload/... 
  return /\/image\/upload\//i.test(input)
}

const tryOptimizeCloudinaryUrl = (input: string, opts: OptimizeImageOptions): string | null => {
  if (!looksLikeCloudinaryImageUploadUrl(input)) return null
  const marker = '/upload/'
  const idx = input.indexOf(marker)
  if (idx < 0) return null

  const before = input.slice(0, idx + marker.length)
  const after = input.slice(idx + marker.length)

  // If the next segment already looks like a transformation (contains ',' or starts with common keys), leave as-is.
  const firstSeg = after.split('/')[0] || ''
  const hasTransformAlready = firstSeg.includes(',') || /^(c_|w_|h_|q_|f_)/.test(firstSeg)
  if (hasTransformAlready) return input

  const width = opts.width && Number.isFinite(opts.width) ? clampInt(opts.width, 16, 4096) : null
  const height = opts.height && Number.isFinite(opts.height) ? clampInt(opts.height, 16, 4096) : null
  const q = opts.quality && Number.isFinite(opts.quality) ? clampInt(opts.quality, 20, 95) : null

  const resize = opts.resize || 'cover'
  const crop = resize === 'contain' ? 'c_fit' : 'c_fill'

  const parts: string[] = [crop]
  if (width) parts.push(`w_${width}`)
  if (height) parts.push(`h_${height}`)
  parts.push('f_auto')
  parts.push('q_auto')
  if (q) parts.push(`q_${q}`)

  const transform = parts.join(',')
  return `${before}${transform}/${after}`
}

/**
 * Returns a URL that is cheaper to download/decode on device.
 * - Supabase Storage public objects are rewritten to `/render/image` with width/height/quality.
 * - Cloudinary `/image/upload` gets an inserted transformation only if missing.
 * - Unknown URLs are returned unchanged.
 */
export const optimizeRemoteImageUrl = (input: string, opts: OptimizeImageOptions = {}): string => {
  const trimmed = (input || '').trim()
  if (!trimmed) return trimmed
  if (!isProbablyHttpUrl(trimmed)) return trimmed

  return (
    tryOptimizeSupabaseStoragePublicObjectUrl(trimmed, opts) ||
    tryOptimizeCloudinaryUrl(trimmed, opts) ||
    trimmed
  )
}
