// Site Worker: the only runtime code for a site. Sits in front of the static Astro output and does four jobs:
//   1. /api/* endpoints          2. edge personalisation (HTMLRewriter)
//   3. auth gating + sessions    4. security headers + cache policy
import site from "../content/site.json";
import segments from "../content/segments.json";
import events from "../content/data/events.json"; // content snapshot, versioned with the deployment

interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  SESSION_SECRET: string;
  FRAME_ANCESTORS?: string; // staging allows the CMS preview pane to embed it; prod stays 'none'
}
declare const HTMLRewriter: any;

const CACHE = {
  html: "public, max-age=0, must-revalidate",
  gated: "private, no-cache",
  "shared-short": "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
  private: "private, no-store",
} as const;

const SESSION_COOKIE = "aicms_session";
const SEGMENT_COOKIE = "aicms_seg";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) return secure(await api(req, url, env), env);

    const gated = isGated(url.pathname);
    if (gated && !(await readSession(req, env))) {
      return redirect(`/login/?next=${encodeURIComponent(url.pathname)}`);
    }

    const asset = await env.ASSETS.fetch(req);
    if (!(asset.headers.get("content-type") ?? "").includes("text/html")) return asset;

    const { segment, setCookie } = resolveSegment(req, url);
    const res = personalise(asset, segment);
    const headers = new Headers(res.headers);
    headers.set("Cache-Control", gated ? CACHE.gated : CACHE.html);
    headers.set("x-aicms-segment", segment ?? "default"); // in prod: part of the edge cache key, never per user
    if (setCookie) headers.append("Set-Cookie", setCookie);
    return secure(new Response(res.body, { status: res.status, headers }), env);
  },
};

// ---------- 1. API endpoints (declared types: content-query, form-submit; per-user) ----------
async function api(req: Request, url: URL, env: Env): Promise<Response> {
  const route = `${req.method} ${url.pathname}`;
  switch (route) {
    case "GET /api/events":
      return json(events, CACHE["shared-short"]);

    case "POST /api/login": {
      const form = await req.formData();
      const name = String(form.get("name") ?? "").trim().slice(0, 40);
      if (!name) return redirect("/login/");
      const token = await createSession(env, { sub: name.toLowerCase(), name });
      return redirect(safeNext(String(form.get("next") ?? "/members/")), {
        "Set-Cookie": `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800`,
      });
    }

    case "POST /api/logout":
      return redirect("/", { "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });

    case "GET /api/me": {
      const s = await readSession(req, env);
      if (!s) return json({ error: "unauthenticated" }, CACHE.private, 401);
      // Demo per-user data. In production: from the customer's systems via a proxy endpoint, or KV/D1.
      return json(
        {
          name: s.name,
          plan: s.name.length % 2 ? "Family" : "Individual",
          appointments: [
            { when: "Tue 2 Dec, 09:30", what: "GP check-up, Northside" },
            { when: "Fri 12 Dec, 14:00", what: "Bloods, Southside" },
          ],
        },
        CACHE.private,
      );
    }
  }
  return json({ error: "not found" }, CACHE.private, 404);
}

// ---------- 2. Edge personalisation ----------
function resolveSegment(req: Request, url: URL): { segment?: string; setCookie?: string } {
  const valid = new Set(segments.map((s) => s.id));
  const cookie = (id: string) => `${SEGMENT_COOKIE}=${id}; Path=/; Secure; SameSite=Lax; Max-Age=2592000`;

  // Preview / QA override: ?seg=<id> (or ?seg=default to clear)
  const forced = url.searchParams.get("seg");
  if (forced === "default") return { setCookie: `${SEGMENT_COOKIE}=; Path=/; Max-Age=0` };
  if (forced && valid.has(forced)) return { segment: forced, setCookie: cookie(forced) };

  const campaign = url.searchParams.get("utm_campaign");
  const byCampaign = campaign && segments.find((s) => s.match.campaign?.includes(campaign));
  if (byCampaign) return { segment: byCampaign.id, setCookie: cookie(byCampaign.id) };

  const fromCookie = cookies(req)[SEGMENT_COOKIE];
  if (fromCookie && valid.has(fromCookie)) return { segment: fromCookie };

  const country = (req as any).cf?.country as string | undefined;
  const byGeo = country && segments.find((s) => s.match.country?.includes(country));
  return { segment: byGeo ? byGeo.id : undefined };
}

function personalise(res: Response, segment?: string): Response {
  return new HTMLRewriter()
    .on("[data-p]", {
      element(el: any) {
        const raw = el.getAttribute("data-p");
        el.removeAttribute("data-p");
        if (!segment || !raw) return;
        try {
          const variants = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))));
          const value = variants[segment];
          if (typeof value === "string") el.setInnerContent(value); // inserted as text, never HTML
        } catch {
          /* malformed marker: leave default content */
        }
      },
    })
    .transform(res);
}

// ---------- 3. Auth: signed, stateless session cookie ----------
type Session = { sub: string; name: string; exp: number };
const enc = new TextEncoder();
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const hmacKey = (secret: string) =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

async function createSession(env: Env, data: Omit<Session, "exp">): Promise<string> {
  const payload = b64u(enc.encode(JSON.stringify({ ...data, exp: Date.now() + 8 * 3600_000 })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret(env)), enc.encode(payload)));
  return `${payload}.${b64u(sig)}`;
}

async function readSession(req: Request, env: Env): Promise<Session | null> {
  const token = cookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret(env)), unb64u(sig), enc.encode(payload));
    if (!ok) return null;
    const s: Session = JSON.parse(new TextDecoder().decode(unb64u(payload)));
    return s.exp > Date.now() ? s : null;
  } catch {
    return null;
  }
}

function secret(env: Env): string {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is not set (copy .dev.vars.example to .dev.vars)");
  return env.SESSION_SECRET;
}

const isGated = (path: string) => site.gated.some((p) => path === p || path.startsWith(p + "/"));

// ---------- 4. Headers & helpers ----------
function secure(res: Response, env: Env): Response {
  const h = new Headers(res.headers);
  h.set("Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    `form-action 'self'; frame-ancestors ${env.FRAME_ANCESTORS || "'none'"}; base-uri 'self'`);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

function json(body: unknown, cacheControl: string, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cacheControl },
  });
}

function redirect(location: string, extra: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": CACHE.private, ...extra } });
}

// Only same-site relative paths: prevents open redirects via ?next=
const safeNext = (next: string) => (/^\/(?!\/)/.test(next) && !next.includes("\\") ? next : "/");

function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get("Cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
