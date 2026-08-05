import { makeUri, type FsUri } from '@foreshadow/core';

/** Normalize host paths for stable comparisons (lowercase drive letters on Windows). */
export function normalizeFsPath(filePath: string): string {
  let normalized = filePath.replace(/\\/g, '/');
  if (normalized.match(/^[a-zA-Z]:/)) {
    normalized = normalized.charAt(0).toLowerCase() + normalized.slice(1);
  }
  return normalized;
}

export function toFsUri(filePath: string): FsUri {
  return makeUri(normalizeFsPath(filePath));
}

export function uriKey(uri: FsUri | null | undefined): string | null {
  if (!uri?.fsPath) {
    return null;
  }
  return normalizeFsPath(uri.fsPath);
}
