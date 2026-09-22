#!/usr/bin/env node
// Maakt SVG-grafieken uit results.json. Nul dependencies, alleen Node stdlib.
// Gebruik: node chart.mjs [results.json]
// Output: chart-models.svg en chart-langs.svg naast de input.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const input = process.argv[2] || join(ROOT, "results.json");
const { meta, results } = JSON.parse(readFileSync(input, "utf8"));

const esc = (s) =>
  String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const color = (rate) =>
  rate >= 0.95 ? "#2da44e" : rate >= 0.8 ? "#7ab648" : rate >= 0.5 ? "#dbab09" : "#cf222e";

function bars({ title, subtitle, rows, out }) {
  const W = 660;
  const labelW = 210;
  const barW = 300;
  const rowH = 46;
  const top = 78;
  const H = top + rows.length * rowH + 24;
  const sorted = [...rows].sort((a, b) => b.rate - a.rate);
  let y = top;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" role="img">`);
  parts.push(`<style>text{font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif}</style>`);
  parts.push(`<rect width="${W}" height="${H}" fill="#ffffff" rx="8"/>`);
  parts.push(`<text x="24" y="30" font-size="17" font-weight="700" fill="#1f2328">${esc(title)}</text>`);
  parts.push(`<text x="24" y="52" font-size="12" fill="#57606a">${esc(subtitle)}</text>`);
  for (const r of sorted) {
    const w = Math.max(3, Math.round(barW * r.rate));
    const c = color(r.rate);
    parts.push(`<text x="24" y="${y + 19}" font-size="13" fill="#1f2328">${esc(r.label)}</text>`);
    parts.push(`<rect x="${labelW}" y="${y}" width="${barW}" height="26" fill="#eaeef2" rx="4"/>`);
    parts.push(`<rect x="${labelW}" y="${y}" width="${w}" height="26" fill="${c}" rx="4"/>`);
    parts.push(`<text x="${labelW + barW + 10}" y="${y + 19}" font-size="13" font-weight="700" fill="#1f2328">${(r.rate * 100).toFixed(1)}%</text>`);
    parts.push(`<text x="${labelW + barW + 10}" y="${y + 35}" font-size="11" fill="#57606a">${esc(r.sub || "")}</text>`);
    y += rowH;
  }
  parts.push(`</svg>`);
  writeFileSync(out, parts.join("\n"));
  console.log(`Geschreven: ${out}`);
}

// Grafiek 1: score per model
bars({
  title: "sst-process-bench: score per model",
  subtitle: `${meta.testsPerModel} tests per model · provider ${meta.provider} · ${meta.date.slice(0, 10)}`,
  rows: results.map((m) => ({
    label: m.model,
    rate: m.passRate,
    sub: `${m.passed}/${m.total} · ${Math.round(m.avgMs)} ms`,
  })),
  out: join(ROOT, "chart-models.svg"),
});

// Grafiek 2: score per taal (alle modellen samen)
const byLang = {};
for (const m of results) {
  for (const d of m.details) {
    const k = d.test.lang;
    byLang[k] = byLang[k] || { pass: 0, total: 0 };
    byLang[k].total++;
    if (!d.error && !d.fails.length) byLang[k].pass++;
  }
}
bars({
  title: "sst-process-bench: score per taal",
  subtitle: `alle modellen samen · ${Object.keys(byLang).length} talen · ${meta.date.slice(0, 10)}`,
  rows: Object.entries(byLang).map(([lang, s]) => ({
    label: lang,
    rate: s.pass / s.total,
    sub: `${s.pass}/${s.total}`,
  })),
  out: join(ROOT, "chart-langs.svg"),
});
