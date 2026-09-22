// SVG analysis charts from results.json. Zero dependencies, Node stdlib only.
// Usage: node chart.mjs [results.json]
// Also imported by bench.mjs to regenerate charts after each run.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));

const PROVIDER_COLORS = {
  groq: "#ff4d00",
  openrouter: "#2f81f7",
  openai: "#2da44e",
  cerebras: "#8250df",
  zai: "#bf3989",
  custom: "#57606a",
};
const colorFor = (provider) => PROVIDER_COLORS[provider] || "#57606a";
const rateColor = (rate) =>
  rate >= 0.95 ? "#2da44e" : rate >= 0.8 ? "#7ab648" : rate >= 0.5 ? "#dbab09" : "#cf222e";

const esc = (s) =>
  String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const FONT = `font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif"`;

function bars({ title, subtitle, rows, out }) {
  const W = 660;
  const labelW = 210;
  const barW = 300;
  const rowH = 46;
  const top = 78;
  const H = top + rows.length * rowH + 24;
  const sorted = [...rows].sort((a, b) => b.rate - a.rate);
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" role="img">`);
  parts.push(`<rect width="${W}" height="${H}" fill="#ffffff" rx="8"/>`);
  parts.push(`<text x="24" y="30" font-size="17" font-weight="700" fill="#1f2328" ${FONT}>${esc(title)}</text>`);
  parts.push(`<text x="24" y="52" font-size="12" fill="#57606a" ${FONT}>${esc(subtitle)}</text>`);
  let y = top;
  for (const r of sorted) {
    const w = Math.max(3, Math.round(barW * r.rate));
    parts.push(`<text x="24" y="${y + 19}" font-size="13" fill="#1f2328" ${FONT}>${esc(r.label)}</text>`);
    parts.push(`<rect x="${labelW}" y="${y}" width="${barW}" height="26" fill="#eaeef2" rx="4"/>`);
    parts.push(`<rect x="${labelW}" y="${y}" width="${w}" height="26" fill="${r.color || rateColor(r.rate)}" rx="4"/>`);
    parts.push(`<text x="${labelW + barW + 10}" y="${y + 19}" font-size="13" font-weight="700" fill="#1f2328" ${FONT}>${(r.rate * 100).toFixed(1)}%</text>`);
    parts.push(`<text x="${labelW + barW + 10}" y="${y + 35}" font-size="11" fill="#57606a" ${FONT}>${esc(r.sub || "")}</text>`);
    y += rowH;
  }
  parts.push(`</svg>`);
  writeFileSync(out, parts.join("\n"));
  return out;
}

// Accuracy vs speed: x = avg latency, y = pass rate, one bubble per model.
function scatter({ title, subtitle, points, out }) {
  const W = 660;
  const H = 420;
  const padL = 56;
  const padR = 170;
  const padT = 70;
  const padB = 48;
  const maxMs = Math.max(1000, ...points.map((p) => p.ms)) * 1.1;
  const minRate = Math.min(0.9, ...points.map((p) => p.rate)) - 0.03;
  const X = (ms) => padL + (ms / maxMs) * (W - padL - padR);
  const Y = (rate) => padT + (1 - (rate - minRate) / (1 - minRate)) * (H - padT - padB);
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" role="img">`);
  parts.push(`<rect width="${W}" height="${H}" fill="#ffffff" rx="8"/>`);
  parts.push(`<text x="24" y="30" font-size="17" font-weight="700" fill="#1f2328" ${FONT}>${esc(title)}</text>`);
  parts.push(`<text x="24" y="52" font-size="12" fill="#57606a" ${FONT}>${esc(subtitle)}</text>`);
  // grid + axes
  for (let g = 0; g <= 4; g++) {
    const rate = minRate + ((1 - minRate) * g) / 4;
    const y = Y(rate);
    parts.push(`<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#eaeef2"/>`);
    parts.push(`<text x="${padL - 8}" y="${y + 4}" font-size="11" text-anchor="end" fill="#57606a" ${FONT}>${(rate * 100).toFixed(0)}%</text>`);
  }
  for (let g = 0; g <= 4; g++) {
    const ms = (maxMs * g) / 4;
    const x = X(ms);
    parts.push(`<text x="${x}" y="${H - padB + 20}" font-size="11" text-anchor="middle" fill="#57606a" ${FONT}>${Math.round(ms)}ms</text>`);
  }
  parts.push(`<text x="${(W - padR + padL) / 2}" y="${H - 8}" font-size="11" text-anchor="middle" fill="#57606a" ${FONT}>avg latency per test</text>`);
  // points
  for (const p of points) {
    const x = X(p.ms).toFixed(1);
    const y = Y(p.rate).toFixed(1);
    parts.push(`<circle cx="${x}" cy="${y}" r="13" fill="${colorFor(p.provider)}" opacity="0.85"/>`);
    parts.push(`<text x="${x}" y="${y + 4}" font-size="10" font-weight="700" text-anchor="middle" fill="#ffffff" ${FONT}>${p.short}</text>`);
  }
  // legend
  const seen = [...new Set(points.map((p) => p.provider))];
  seen.forEach((prov, i) => {
    const y = padT + 10 + i * 24;
    parts.push(`<circle cx="${W - padR + 16}" cy="${y}" r="7" fill="${colorFor(prov)}"/>`);
    parts.push(`<text x="${W - padR + 30}" y="${y + 4}" font-size="12" fill="#1f2328" ${FONT}>${esc(prov)}</text>`);
  });
  points.forEach((p, i) => {
    parts.push(`<text x="${W - padR + 10}" y="${padT + 10 + seen.length * 24 + i * 18}" font-size="11" fill="#57606a" ${FONT}>${esc(p.short)} = ${esc(p.label)}</text>`);
  });
  parts.push(`</svg>`);
  writeFileSync(out, parts.join("\n"));
  return out;
}

export function generateCharts(inputPath) {
  const { meta, results } = JSON.parse(readFileSync(inputPath, "utf8"));
  const dir = dirname(inputPath);
  const providers = meta.providers || [meta.provider];
  for (const r of results) {
    if (!r.provider) r.provider = providers[0] || "unknown";
  }
  const subtitle = `${meta.testsPerModel} tests per model · ${providers.join(", ")} · ${String(meta.date).slice(0, 10)}`;
  const multi = new Set(results.map((r) => r.provider)).size > 1;
  const files = [];
  files.push(bars({
    title: "Verbatim Bench: score per model",
    subtitle,
    rows: results.map((m) => ({
      label: multi ? `${m.provider}/${m.model}` : m.model,
      rate: m.passRate,
      sub: `${m.passed}/${m.total} · ${Math.round(m.avgMs)} ms`,
    })),
    out: join(dir, "chart-models.svg"),
  }));
  const byLang = {};
  for (const m of results) {
    for (const d of m.details) {
      const k = d.test.lang;
      byLang[k] = byLang[k] || { pass: 0, total: 0 };
      byLang[k].total++;
      if (!d.error && !d.fails.length) byLang[k].pass++;
    }
  }
  files.push(bars({
    title: "Verbatim Bench: score per language",
    subtitle: `all models combined · ${Object.keys(byLang).length} languages · ${String(meta.date).slice(0, 10)}`,
    rows: Object.entries(byLang).map(([lang, s]) => ({
      label: lang,
      rate: s.pass / s.total,
      sub: `${s.pass}/${s.total}`,
    })),
    out: join(dir, "chart-langs.svg"),
  }));
  files.push(scatter({
    title: "Verbatim Bench: accuracy vs speed",
    subtitle,
    points: results.map((m, i) => ({
      label: multi ? `${m.provider}/${m.model}` : m.model,
      short: `M${i + 1}`,
      provider: m.provider,
      rate: m.passRate,
      ms: Math.round(m.avgMs),
    })),
    out: join(dir, "chart-scatter.svg"),
  }));
  return files;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const files = generateCharts(process.argv[2] || join(ROOT, "results.json"));
  for (const f of files) console.log(`Written: ${f}`);
}
