/**
 * Photo SSOT plugin
 *
 * 저장소 루트의 `photo/`를 단일 출처로 두고 security-viz에서 `/photo/*`로 접근하게 한다.
 *  - dev 서버: `/photo/*` 요청을 `<repo-root>/photo/`에서 직접 서빙
 *  - build:    파일들을 `dist/photo/`로 복사
 *
 * 이로써 `security-viz/public/photo/`에 동일 파일을 중복 보관할 필요가 없어진다.
 */

import fs from "node:fs";
import path from "node:path";
import type { Plugin, ViteDevServer } from "vite";

const REPO_ROOT = path.resolve(__dirname, "..");
const PHOTO_DIR = path.join(REPO_ROOT, "photo");

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

function safeJoin(base: string, requested: string): string | null {
  const resolved = path.normalize(path.join(base, requested));
  if (!resolved.startsWith(base + path.sep) && resolved !== base) return null;
  return resolved;
}

export function photoSsotPlugin(): Plugin {
  return {
    name: "sg-photo-ssot",
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/photo", (req, res, next) => {
        if (!req.url) return next();
        const rel = decodeURIComponent(req.url.split("?")[0] ?? "");
        const filePath = safeJoin(PHOTO_DIR, rel);
        if (!filePath) return next();
        if (!fs.existsSync(filePath)) return next();
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return next();
        const ext = path.extname(filePath).toLowerCase();
        res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
        res.setHeader("Cache-Control", "no-cache");
        fs.createReadStream(filePath).pipe(res);
      });
    },
    generateBundle() {
      if (!fs.existsSync(PHOTO_DIR)) return;
      for (const name of fs.readdirSync(PHOTO_DIR)) {
        const full = path.join(PHOTO_DIR, name);
        if (!fs.statSync(full).isFile()) continue;
        this.emitFile({
          type: "asset",
          fileName: `photo/${name}`,
          source: fs.readFileSync(full),
        });
      }
    },
  };
}
