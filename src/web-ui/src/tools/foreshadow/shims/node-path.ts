/**
 * Browser-safe path helpers for @foreshadow/core (join / dirname / extname).
 * Prefer path-browserify when available; fall back to minimal POSIX-ish helpers.
 */
import pathBrowserify from 'path-browserify';

type PathApi = {
  join: (...parts: string[]) => string;
  dirname: (p: string) => string;
  extname: (p: string) => string;
  basename: (p: string, ext?: string) => string;
  resolve: (...parts: string[]) => string;
  normalize: (p: string) => string;
  sep: string;
  posix: PathApi;
  win32: PathApi;
};

const api = pathBrowserify as unknown as PathApi;

export const join = api.join.bind(api);
export const dirname = api.dirname.bind(api);
export const extname = api.extname.bind(api);
export const basename = api.basename.bind(api);
export const resolve = api.resolve.bind(api);
export const normalize = api.normalize.bind(api);
export const sep = api.sep ?? '/';
export const posix = api.posix ?? api;
export const win32 = api.win32 ?? api;

export default api;
