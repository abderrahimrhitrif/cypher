/** Small shared helpers used across services and UI. */

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function truncate(text: string, max: number, suffix = "..."): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - suffix.length)).trimEnd() + suffix;
}

/**
 * Normalizes a folder entry from settings: strips leading/trailing slashes and
 * whitespace so `.obsidian/` and `/templates` match real vault paths.
 */
export function normalizeFolder(folder: string): string {
  return folder.trim().replace(/^\/+|\/+$/g, "");
}

export function normalizeExcludedFolders(folders: string[]): string[] {
  return folders.map(normalizeFolder).filter((folder) => folder.length > 0);
}

export function isPathExcluded(path: string, excludedFolders: string[]): boolean {
  for (const raw of excludedFolders) {
    const folder = normalizeFolder(raw);
    if (!folder) continue;
    if (path === folder || path.startsWith(`${folder}/`)) {
      return true;
    }
  }
  return false;
}

/** Trims trailing slashes and known endpoint suffixes off an API base URL. */
export function normalizeBaseUrl(url: string): string {
  let clean = url.trim().replace(/\/+$/, "");
  for (const suffix of ["/chat/completions", "/embeddings", "/models"]) {
    if (clean.endsWith(suffix)) {
      clean = clean.slice(0, -suffix.length);
    }
  }
  return clean;
}
