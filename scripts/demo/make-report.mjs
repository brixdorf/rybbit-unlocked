#!/usr/bin/env node
/**
 * Builds REPORT.md (before | after table) from manifest-before.json, manifest-after.json and the generator log.
 *   node make-report.mjs <out_dir> [generator.log]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const out = path.resolve(process.argv[2] || "scripts/demo/screenshots");
const genLog = process.argv[3];
const read = p => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : []);
const before = read(path.join(out, "manifest-before.json"));
const after = read(path.join(out, "manifest-after.json"));
const esc = s => String(s || "").replace(/\|/g, "\\|").replace(/\n/g, " ");

const ids = [...new Set([...before, ...after].filter(m => !m.id.endsWith("a")).map(m => m.id))].sort();
const cell = m => {
  if (!m) return "_not captured_";
  if (m.status === "ok") {
    const redirected = m.url ? `<br><sub>final URL: \`${esc(m.url)}\`</sub>` : "";
    const txt = m.text ? `<br><sub>page text: ${esc(m.text.slice(0, 110))}</sub>` : "";
    return `![${esc(m.caption)}](${m.file})${redirected}${txt}`;
  }
  return `_${m.status}: ${esc(m.note) || "n/a"}_${m.url ? `<br><sub>final URL: \`${esc(m.url)}\`</sub>` : ""}`;
};

let md = `# Before / after: stock Rybbit vs rybbit-unlocked

Both columns were captured against the **same database** (same Postgres, ClickHouse and generated traffic), with the
same Playwright script (\`scripts/demo/screenshots.mjs\`), viewport 1440x900 at 2x. Left: stock upstream
commit. Right: this fork. Pages that stock hides from the navigation are still opened by direct URL and shown as they
render. Generated: ${new Date().toISOString()}

| Screen | Before (stock) | After (unlocked fork) |
| --- | --- | --- |
`;
for (const id of ids) {
  const b = before.find(m => m.id === id);
  const a = after.find(m => m.id === id);
  const cap = (a || b).caption;
  md += `| **${id}** ${esc(cap)} | ${cell(b)} | ${cell(a)} |\n`;
}

const adminB = before.find(m => m.id === "15a");
const adminA = after.find(m => m.id === "15a");
md += `\n## Observations from the run\n\n`;
md += `- Admin link in app rail: before **${adminB?.status ?? "n/a"}**, after **${adminA?.status ?? "n/a"}**.\n`;
for (const id of ids) {
  const b = before.find(m => m.id === id);
  const a = after.find(m => m.id === id);
  if (b && a && b.url !== a.url) md += `- ${id} ${esc(a.caption)}: stock ended on \`${b.url}\`, fork on \`${a.url}\`.\n`;
  if (b?.status === "absent" || a?.status === "absent") md += `- ${id} ${esc((a || b).caption)}: before=${b?.status}, after=${a?.status}.\n`;
}

if (genLog && existsSync(genLog)) {
  const lines = readFileSync(genLog, "utf8").split("\n");
  const tail = lines.slice(-40).join("\n").trim();
  md += `\n## Traffic generator summary\n\nLast lines of \`generate-traffic.mjs\` output (the same data feeds both columns):\n\n\`\`\`\n${tail}\n\`\`\`\n`;
}
md += `\nNote: the Realtime count reflects the \`--live\` phase and decays after a few minutes, so it can differ between the two captures even though the stored history is identical.\n`;
writeFileSync(path.join(out, "REPORT.md"), md);
console.log(`wrote ${path.join(out, "REPORT.md")}`);
