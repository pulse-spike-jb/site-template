// Preview renderer only: carry the changeset, preview token and segment on every internal link, so clicking around
// inside the preview stays in the same changeset without relying on cookies. The preview runs on its own domain
// inside a CMS iframe, where third-party cookies are often blocked. Static builds never set these locals, so this
// is a no-op there and production HTML is untouched.
import { defineMiddleware } from "astro:middleware";

export const onRequest = defineMiddleware(async (ctx, next) => {
  const res = await next();
  const { previewCs, previewToken, previewSeg } = ctx.locals as Record<string, string | undefined>;
  if (!previewToken || !(res.headers.get("content-type") ?? "").includes("text/html")) return res;

  const params = new URLSearchParams({ cs: previewCs ?? "main", pt: previewToken });
  if (previewSeg) params.set("seg", previewSeg);
  const html = (await res.text()).replace(
    /href="(\/(?!\/|_astro\/)[^"#?]*)(\?[^"#]*)?(#[^"]*)?"/g,
    (_m, path: string, query = "", hash = "") => `href="${path}${query ? `${query}&amp;` : "?"}${params.toString().replace(/&/g, "&amp;")}${hash}"`,
  );
  return new Response(html, res);
});
