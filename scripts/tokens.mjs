// Compiles design-system/tokens.json into CSS custom properties.
// Components may only reference these variables, never raw values (in the real product this is the Tailwind theme).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const tokens = JSON.parse(readFileSync("design-system/tokens.json", "utf8"));
const lines = [];
for (const [group, values] of Object.entries(tokens)) {
  for (const [name, value] of Object.entries(values)) lines.push(`  --${group}-${name}: ${value};`);
}
mkdirSync("src/styles", { recursive: true });
writeFileSync("src/styles/tokens.css", `/* generated from design-system/tokens.json — do not edit */\n:root {\n${lines.join("\n")}\n}\n`);
console.log(`tokens: ${lines.length} variables written`);
