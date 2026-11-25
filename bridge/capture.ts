import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

// ponytail: dirs are never deleted; the OS clears tmp. Add a sweep if it matters.
export async function writeCapture(baseDir: string, id: string, png: Uint8Array, text: string): Promise<string> {
  const dir = join(baseDir, id)
  await mkdir(dir, { recursive: true })
  await Promise.all([Bun.write(join(dir, 'shot.png'), png), Bun.write(join(dir, 'page.txt'), text)])
  return dir
}
