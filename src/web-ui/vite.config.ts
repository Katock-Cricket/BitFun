import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { versionInjectionPlugin } from "./vite.config.version-plugin";
import { bitfunCanvasRuntimeBundlePlugin } from "./vite.config.canvas-runtime-plugin";

const host = process.env.TAURI_DEV_HOST;

/**
 * CREDIT（P1 开发期辅助）：监听 @credit/* 的构建产物变化，自动失效模块图并刷新页面。
 *
 * 背景：`@credit/core` 是本地 file: 依赖，改完 core 需要 rebuild + 同步 dist。
 * 但 Vite dev server 会把已加载的依赖模块缓存在进程内，不重启就读不到新代码，
 * 导致"明明改了却还是旧行为"的反复排查。本插件让 dist 一变就自动重载。
 */
function creditCoreReloadPlugin() {
  return {
    name: "credit-core-reload",
    configureServer(server: any) {
      // @credit 模块强制不缓存：否则浏览器会一直复用带 ?v= 的旧 dist，
      // 表现为"磁盘已是新版本，页面却还是旧行为"（重启 dev server 也无效）。
      server.middlewares.use((req: any, res: any, next: any) => {
        if (typeof req?.url === "string" && req.url.includes("@credit")) {
          res.setHeader("Cache-Control", "no-store, must-revalidate");
        }
        next();
      });
      const glob = path
        .resolve(__dirname, "../../node_modules/.pnpm/*/node_modules/@credit/*/dist/**/*.js")
        .replace(/\\/g, "/");
      try {
        server.watcher.add(glob);
      } catch {
        /* watcher 不支持 glob 时忽略（不影响构建） */
      }
      const onChange = (file: string) => {
        if (!file || !file.includes("@credit")) return;
        try {
          server.moduleGraph?.invalidateAll?.();
        } catch {
          /* noop */
        }
        const ws = server.hot ?? server.ws;
        try {
          ws?.send?.({ type: "full-reload" });
        } catch {
          /* noop */
        }
      };
      server.watcher.on("change", onChange);
      server.watcher.on("add", onChange);
    },
  };
}

/**
 * Native fs events do not work reliably on UNC network shares (\\server\...,
 * including \\wsl$ / \\wsl.localhost) or on WSL drvfs mounts (/mnt/<drive>).
 * Users upgrading from the polling-based watcher would silently lose HMR
 * there, so print a one-line hint pointing at the VITE_USE_POLLING escape
 * hatch.
 */
function warnIfNativeWatchUnreliable(): void {
  const cwd = process.cwd();
  const looksLikeNetworkOrWslMount =
    cwd.startsWith("\\\\") || /^\/mnt\/[a-z]\//i.test(cwd);
  if (looksLikeNetworkOrWslMount) {
    console.warn(
      `[bitfun] Project path "${cwd}" looks like a network share or WSL mount; ` +
        "native file watching may miss changes here. " +
        "Set VITE_USE_POLLING=1 to restore polling-based HMR.",
    );
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  const isProduction = mode === 'production' || (command === 'build' && mode !== 'development');

  if (command === 'serve' && !process.env.VITE_USE_POLLING) {
    warnIfNativeWatchUnreliable();
  }

  return {
    plugins: [
      react(),
      creditCoreReloadPlugin(),
      bitfunCanvasRuntimeBundlePlugin(),
      versionInjectionPlugin()
    ],

    // Path resolution
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: {
        "@": path.resolve(__dirname, "./src"),
        "@/shared": path.resolve(__dirname, "./src/shared"),
        "@/core": path.resolve(__dirname, "./src/core"),
        "@/tools": path.resolve(__dirname, "./src/tools"),
        "@/hooks": path.resolve(__dirname, "./src/hooks"),
        "@/styles": path.resolve(__dirname, "./src/component-library/styles"),
        "@/types": path.resolve(__dirname, "./src/shared/types"),
        "@/utils": path.resolve(__dirname, "./src/shared/utils"),
        "@components": path.resolve(__dirname, "./src/component-library/components"),
      },
    },

  css: {
    preprocessorOptions: {
      scss: {
        // SCSS preprocessing options (sourcemap is controlled by build.sourcemap)
      },
    },
    // dev mode enabled, release mode disabled
    devSourcemap: !isProduction,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1422,
    // Tauri devUrl is fixed to http://localhost:1422.
    // If Vite silently falls back to another port, the desktop webview stays blank.
    strictPort: true,
    host: host || "localhost",
    hmr: {
      protocol: "ws",
      host: host || "localhost",
      port: 1421,
    },
    // Allow access to workspace root for dependencies like monaco-editor
    fs: {
      allow: [
        path.resolve(__dirname, '../../'), // Workspace root
      ],
    },
    watch: {
      // 3. tell Vite to ignore watching `src-tauri` and `apps`
      ignored: ["**/src-tauri/**", "**/apps/**"],
      // Native fs events by default (polling burned CPU scanning ~1.7k files
      // every 100ms). Escape hatch for network drives / exotic filesystems:
      // set VITE_USE_POLLING=1 to re-enable polling.
      ...(process.env.VITE_USE_POLLING
        ? { usePolling: true, interval: 1000 }
        : {}),
    },
  },

  // Optimize dependency pre-building
  optimizeDeps: {
    // Exclude dependencies that need to be dynamically loaded
    //
    // CREDIT（P1）：@credit/* 是本地 file: 依赖（workspace 内源码的构建产物）。
    // 若走预构建，其 deps 缓存不会随 dist 内容变化而失效，导致 Bitfun 加载到**旧版** core
    // ——表现为 P1 新增方法缺失（recover/syncSession is not a function）、数据写入旧格式 prId。
    // 故排除预构建，dev 期始终从磁盘加载，改完 core 重启即可生效。
    exclude: ["@credit/core", "@credit/protocol"],
    // Force pre-building dependencies
    // Resolve Vite 7 and React 18 compatibility issues
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'mermaid',
      'mermaid/dist/mermaid.esm.min.mjs',
    ],
  },

  // Build options
  build: {
    // Enable CSS code splitting
    cssCodeSplit: true,
    // release version disable sourcemap, dev/debug version enable
    sourcemap: !isProduction,
    // Output to the project root directory dist/
    outDir: '../../dist',
    // Empty the output directory
    emptyOutDir: true,
  }
  };
});
