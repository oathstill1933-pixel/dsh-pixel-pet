/**
 * Pack path primitives: id rules, directory layout, and the frame-file guard.
 *
 * Enumeration and layer resolution live in lib/packkit.js since M0 (统一解析单一入口) —
 * nothing should re-implement "which folder wins" here. This module keeps only the pieces
 * every reader shares: the id regex, the kind -> folder/file mapping, and packFrame().
 */
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'

export const PACK_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
export const KIND_DIR = { character: 'characters', furniture: 'furniture' }
export const KIND_FILE = { character: 'character.json', furniture: 'furniture.json' }

/**
 * One picture inside a pack, by the relative path its manifest uses.
 * Accepts nested names ("assets/nested/帧.png") and unicode, but never an absolute path, a ".." segment,
 * a symlinked file, a symlinked intermediate directory, or a pack folder that is itself a link.
 */
export function packFrame (dir, rel) {
  if (!dir || typeof rel !== 'string') return null
  // manifests always use "/" — normalize() would hand back backslashes on Windows
  const norm = String(rel).replace(/\\/g, '/').replace(/^\.\//, '')
  if (!norm || isAbsolute(norm) || /^[A-Za-z]:/.test(norm)) return null
  if (/[\x00-\x1f<>:"|?*]/.test(norm)) return null
  const parts = norm.split('/')
  if (parts.some((p) => !p || p === '.' || p === '..')) return null
  if (!/\.(png|jpe?g|webp)$/i.test(norm)) return null
  const full = resolve(dir, norm)
  const base = resolve(dir) + sep
  if (!full.startsWith(base)) return null
  try {
    if (lstatSync(dir).isSymbolicLink()) return null
    if (lstatSync(full).isSymbolicLink() || !lstatSync(full).isFile()) return null
    // a link anywhere on the way out would make realpath leave the pack: refuse it
    const realDir = realpathSync(dir)
    if (!realpathSync(full).startsWith(realDir + sep)) return null
    return full
  } catch { return null }
}

/** safe join used by routes that already validated every segment */
export function insideDir (base, ...parts) {
  const root = resolve(base)
  const full = resolve(root, ...parts.map((p) => String(p)))
  return full === root || full.startsWith(root + sep) ? full : null
}
