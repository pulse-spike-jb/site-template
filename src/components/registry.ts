import Hero from "./Hero.astro";
import FeatureGrid from "./FeatureGrid.astro";
import CTA from "./CTA.astro";
import EventList from "./EventList.astro";
import AccountPanel from "./AccountPanel.astro";
import LoginForm from "./LoginForm.astro";
import type { ComponentName } from "../lib/manifests";

export const registry: Record<ComponentName, any> = { Hero, FeatureGrid, CTA, EventList, AccountPanel, LoginForm };
