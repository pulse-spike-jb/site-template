// Loads content/pages/**/page.json, validates every page against the schema and component manifests,
// and fails the build (the validation gate) on anything outside the design contract.
import { z } from "zod";
import { manifests, type ComponentName } from "./manifests";
import segments from "../../content/segments.json";

const segmentIds = new Set(segments.map((s) => s.id));

const SectionSchema = z
  .object({
    id: z.string().regex(/^sec_[a-z0-9_]+$/),
    name: z.string().optional(),
    component: z.enum(Object.keys(manifests) as [ComponentName, ...ComponentName[]]),
    props: z.record(z.string(), z.unknown()),
    personalise: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  })
  .strict();

const PageSchema = z
  .object({
    id: z.string().regex(/^pg_[a-z0-9_]+$/),
    title: z.string().min(1),
    seo: z.object({ description: z.string().max(160) }).strict().optional(),
    sections: z.array(SectionSchema),
  })
  .strict();

export type Section = z.infer<typeof SectionSchema> & { props: Record<string, any> };
export type Page = z.infer<typeof PageSchema> & { path: string; sections: Section[] };

export function loadPages(): Page[] {
  const files = import.meta.glob("/content/pages/**/page.json", { eager: true, import: "default" });
  const errors: string[] = [];
  const pages: Page[] = [];

  for (const [file, raw] of Object.entries(files)) {
    const path = file.replace(/^\/content\/pages\/?/, "").replace(/\/?page\.json$/, "");
    const result = validatePage(raw, path, file);
    errors.push(...result.errors);
    if (result.page) pages.push(result.page);
  }

  if (errors.length) throw new Error(`Content validation failed:\n  - ${errors.join("\n  - ")}`);
  return pages.sort((a, b) => a.path.localeCompare(b.path));
}

/** Validates one page against the page schema and component manifests. Shared by the static build and the preview renderer. */
export function validatePage(raw: unknown, path: string, file: string): { page?: Page; errors: string[] } {
  const errors: string[] = [];
  const parsed = PageSchema.safeParse(raw);
  if (!parsed.success) {
    return { errors: [`${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`] };
  }
  const sections = parsed.data.sections.map((s) => {
    const m = manifests[s.component];
    const props = m.props.safeParse(s.props);
    if (!props.success) {
      errors.push(`${file} › ${s.id} (${s.component}): ${props.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    for (const [seg, values] of Object.entries(s.personalise ?? {})) {
      if (!segmentIds.has(seg)) errors.push(`${file} › ${s.id}: unknown segment "${seg}"`);
      for (const prop of Object.keys(values)) {
        if (!(m.personalisable as readonly string[]).includes(prop))
          errors.push(`${file} › ${s.id}: prop "${prop}" is not personalisable on ${s.component}`);
      }
    }
    return { ...s, props: props.success ? props.data : {} };
  });
  return { page: { ...parsed.data, path, sections }, errors };
}

/**
 * Preview renderer only: fetch a page as materialised for a changeset from the platform's content API.
 * The renderer holds no secret. It forwards the signed, short-lived preview token it received with the request,
 * and the content API checks that the token is valid for this site and changeset.
 */
export async function loadPreviewPage(path: string, changeset: string, token: string): Promise<{ page?: Page; status: number; errors?: string[] }> {
  const api = process.env.AICMS_CONTENT_API;
  if (!api) return { status: 500, errors: ["AICMS_CONTENT_API is not set"] };
  if (!token) return { status: 401, errors: ["No preview token. Open the preview from the CMS."] };
  const res = await fetch(`${api}?cs=${encodeURIComponent(changeset)}&path=${encodeURIComponent(path)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { status: res.status, errors: [(await res.json().catch(() => ({})))?.error ?? res.statusText] };
  const { page: raw } = await res.json();
  const result = validatePage(raw, path, `/content/pages/${path ? path + "/" : ""}page.json (changeset ${changeset})`);
  return result.errors.length ? { status: 422, errors: result.errors } : { status: 200, page: result.page };
}

/** The value of a prop for the current segment. Static builds have no segment (the Worker personalises at the edge); the preview renderer sets one. */
export function text(section: Section, prop: string, segment?: string): string {
  const variant = segment ? section.personalise?.[segment]?.[prop] : undefined;
  return variant ?? section.props[prop];
}

/** Marks a personalisable slot. The site Worker swaps in the visitor's segment variant at the edge. */
export function slot(section: Section, prop: string): Record<string, string> {
  const variants: Record<string, string> = {};
  for (const [seg, values] of Object.entries(section.personalise ?? {})) {
    if (values[prop] !== undefined) variants[seg] = values[prop];
  }
  if (!Object.keys(variants).length) return {};
  return { "data-p": Buffer.from(JSON.stringify(variants), "utf8").toString("base64") };
}
