// Component manifests: the design contract the AI composes against.
// Props are Zod-validated at build time; token-like values are enums; only listed props can be personalised.
import { z } from "zod";

const internalHref = z.string().regex(/^\/(?!\/)/, "must be an internal path starting with /");
const tone = z.enum(["primary", "surface"]); // maps to colour tokens, never raw colours

export const manifests = {
  Hero: {
    hydration: "none",
    props: z
      .object({
        heading: z.string().min(1).max(120),
        subheading: z.string().max(240).optional(),
        ctaLabel: z.string().max(40).optional(),
        ctaHref: internalHref.optional(),
        tone: tone.default("primary"),
      })
      .strict(),
    personalisable: ["heading", "subheading", "ctaLabel"],
  },
  FeatureGrid: {
    hydration: "none",
    props: z
      .object({
        heading: z.string().max(120),
        items: z.array(z.object({ title: z.string().max(60), body: z.string().max(240) }).strict()).min(1).max(6),
      })
      .strict(),
    personalisable: [],
  },
  CTA: {
    hydration: "none",
    props: z.object({ heading: z.string().max(120), label: z.string().max(40), href: internalHref }).strict(),
    personalisable: ["heading", "label"],
  },
  EventList: {
    hydration: "visible",
    endpoints: ["/api/events"],
    props: z.object({ heading: z.string().max(120) }).strict(),
    personalisable: [],
  },
  AccountPanel: {
    hydration: "load",
    endpoints: ["/api/me"],
    props: z.object({}).strict(),
    personalisable: [],
  },
  LoginForm: {
    hydration: "none",
    props: z.object({ heading: z.string().max(120) }).strict(),
    personalisable: [],
  },
} as const;

export type ComponentName = keyof typeof manifests;
