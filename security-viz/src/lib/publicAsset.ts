/** `public/` 파일·`/api/*` 등 사이트 루트 경로 — `vite.config`의 `base`(GitHub Pages 등)를 반영합니다. */
function fromSiteRoot(path: string): string {
  const base = import.meta.env.BASE_URL;
  const normalized = path.replace(/^\/+/, "");
  return `${base}${normalized}`;
}

export const publicAsset = fromSiteRoot;
export const apiPath = fromSiteRoot;
