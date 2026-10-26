import type { SupabaseClient } from '@supabase/supabase-js'

/** Private bucket for assignment files and submissions. Created by the 20261026090000 migration. */
export const BUCKET = 'synqop-files'
/** Upload limit (§12 proposal): 25 MB. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024

/**
 * File storage the API needs. Browsers upload straight to storage with a one-time signed URL,
 * then tell the API the path; downloads use short-lived signed URLs. Swappable in tests.
 */
export interface FileStorage {
  /** A one-time upload URL and token for this path (valid 2 hours). */
  createUpload(path: string): Promise<{ path: string; token: string; signedUrl: string }>
  /** Size and type of an uploaded object, or null if nothing is there. */
  stat(path: string): Promise<{ size: number; type: string | null } | null>
  /** A download link valid for 5 minutes that saves the file under `fileName`. */
  downloadUrl(path: string, fileName: string): Promise<string>
  /** A link to show the file in the page (e.g. a profile photo), valid for `seconds`. */
  viewUrl(path: string, seconds: number): Promise<string>
  remove(paths: string[]): Promise<void>
  /** The file's bytes, or null if it's gone. For data exports (F1.10). */
  read(path: string): Promise<Uint8Array | null>
}

export function createSupabaseStorage(supabase: SupabaseClient): FileStorage {
  const bucket = () => supabase.storage.from(BUCKET)
  return {
    async createUpload(path) {
      const { data, error } = await bucket().createSignedUploadUrl(path)
      if (error) throw error
      return { path: data.path, token: data.token, signedUrl: data.signedUrl }
    },
    async stat(path) {
      const { data, error } = await bucket().info(path)
      if (error) {
        if ((error as { status?: number; statusCode?: string }).status === 404 || /not.?found/i.test(error.message)) return null
        throw error
      }
      const info = data as { size?: number; contentType?: string | null; metadata?: { size?: number; mimetype?: string } }
      return { size: Number(info.size ?? info.metadata?.size ?? 0), type: info.contentType ?? info.metadata?.mimetype ?? null }
    },
    async downloadUrl(path, fileName) {
      const { data, error } = await bucket().createSignedUrl(path, 300, { download: fileName })
      if (error) throw error
      return data.signedUrl
    },
    async viewUrl(path, seconds) {
      const { data, error } = await bucket().createSignedUrl(path, seconds)
      if (error) throw error
      return data.signedUrl
    },
    async remove(paths) {
      if (!paths.length) return
      const { error } = await bucket().remove(paths)
      if (error) throw error
    },
    async read(path) {
      const { data, error } = await bucket().download(path)
      if (error) {
        if ((error as { status?: number }).status === 404 || /not.?found/i.test(error.message)) return null
        throw error
      }
      return new Uint8Array(await data.arrayBuffer())
    },
  }
}

/** Keeps a file name readable but safe as a storage key. */
export function safeFileName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
  return (cleaned || 'file').slice(-120)
}
