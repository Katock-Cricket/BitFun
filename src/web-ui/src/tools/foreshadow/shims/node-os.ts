/**
 * Browser-safe shim for Node's `os` module.
 * @foreshadow/core currently imports `os` for terminal cmd classification only.
 */
export function platform(): NodeJS.Platform {
  if (typeof process !== 'undefined' && typeof process.platform === 'string' && process.platform) {
    return process.platform as NodeJS.Platform;
  }
  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent || '';
    if (/Windows/i.test(ua)) return 'win32';
    if (/Mac OS X|Macintosh/i.test(ua)) return 'darwin';
    if (/Linux/i.test(ua)) return 'linux';
  }
  // Tauri desktop on Windows is a common BitFun host; default conservatively.
  return 'win32';
}

export default { platform };
