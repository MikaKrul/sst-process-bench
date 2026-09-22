#!/usr/bin/env node
// sst-process-bench: benchmark voor speech-to-text post-processing modellen.
// Nul dependencies. Alleen Node 18+ stdlib (fetch, fs, process).
// Werkt met elke OpenAI-compatible API: Groq, OpenRouter, OpenAI, Cerebras...

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HANDY_LANGUAGES, CORE_LANGS } from "./langs.mjs";
import { DEEP_CASES, SMOKE_RAW } from "./cases.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const VERSION = "0.1.0";

const PROVIDERS = {
  groq: {
    base: "https://api.groq.com/openai/v1",
    env: "GROQ_API_KEY",
    fallbackModels: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
  },
  openrouter: {
    base: "https://openrouter.ai/api/v1",
    env: "OPENROUTER_API_KEY",
    fallbackModels: [
      "meta-llama/llama-3.3-70b-instruct",
      "google/gemini-2.0-flash-001",
    ],
  },
  openai: {
    base: "https://api.openai.com/v1",
    env: "OPENAI_API_KEY",
    fallbackModels: ["gpt-4o-mini", "gpt-4o"],
  },
  cerebras: {
    base: "https://api.cerebras.ai/v1",
    env: "CEREBRAS_API_KEY",
    fallbackModels: ["llama-3.3-70b"],
  },
  zai: {
    base: "https://api.z.ai/api/paas/v4",
    env: "ZAI_API_KEY",
    fallbackModels: ["glm-4-plus"],
  },
  custom: {
    base: "http://localhost:11434/v1",
    env: "CUSTOM_API_KEY",
    fallbackModels: [],
  },
};

function help() {
  console.log(`sst-process-bench v${VERSION} — post-processing benchmark (nul dependencies)

GEBRUIK:
  node bench.mjs --provider groq --models llama-3.3-70b-versatile
  node bench.mjs --provider openrouter --all
  node bench.mjs --list-models --provider groq

API-KEY (eerste hit wint):
  --api-key XXX            direct meegeven
  GROQ_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY / ... als env-var
  --api-key-file pad       bestand met alleen de key (geen newline-probleem)

OPTIES:
  --provider NAME    ${Object.keys(PROVIDERS).join("|")} (default: groq, of auto via env)
  --base-url URL     override voor custom endpoints
  --models a,b,c     kommagescheiden modellen (default: provider-fallback)
  --all              test alle modellen van /models (let op: duur)
  --list-models      toon beschikbare modellen en stop
  --lang nl,en,de    alleen deze talen (default: kernset van ${CORE_LANGS.length} talen)
  --all-langs        alle ${HANDY_LANGUAGES.length} Handy-talen (smoke) + alle diepe tests
  --deep-only        alleen strikte tests, geen smoke-tests
  --prompt-file F    eigen systeem-prompt (default: prompt.txt)
  --active-window S  waarde voor \${active_window} (default: "VS Code")
  --concurrency N    parallelle requests (default: 3)
  --timeout S        timeout per request in sec (default: 60)
  --retries N        retries bij 429/5xx (default: 2)
  --out-json F       JSON-resultaat (default: results.json)
  --out-md F         Markdown-ranking (default: results.md)
  --no-out           schrijf geen bestanden
  --dry-run          toon plan (modellen x tests) zonder API-calls
  --self-test        offline check van de scoring, zonder API-key
  --verbose          toon elke output
  -h, --help         deze hulp
`);
}

// ---------- args ----------
function parseArgs(argv) {
  const o = {
    provider: null, apiKey: null, apiKeyFile: null, baseUrl: null,
    models: null, all: false, listModels: false, lang: null,
    allLangs: false, deepOnly: false, promptFile: join(ROOT, "prompt.txt"),
    activeWindow: "VS Code", concurrency: 3, timeout: 60, retries: 2,
    outJson: "results.json", outMd: "results.md", noOut: false,
    dryRun: false, selfTest: false, verbose: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? "";
    if (a === "--provider") o.provider = next();
    else if (a === "--api-key") o.apiKey = next();
    else if (a === "--api-key-file") o.apiKeyFile = next();
    else if (a === "--base-url") o.baseUrl = next();
    else if (a === "--models") o.models = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--all") o.all = true;
    else if (a === "--list-models") o.listModels = true;
    else if (a === "--lang") o.lang = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--all-langs") o.allLangs = true;
    else if (a === "--deep-only") o.deepOnly = true;
    else if (a === "--prompt-file") o.promptFile = next();
    else if (a === "--active-window") o.activeWindow = next();
    else if (a === "--concurrency") o.concurrency = Math.max(1, parseInt(next(), 10) || 3);
    else if (a === "--timeout") o.timeout = Math.max(5, parseInt(next(), 10) || 60);
    else if (a === "--retries") o.retries = Math.max(0, parseInt(next(), 10) || 0);
    else if (a === "--out-json") o.outJson = next();
    else if (a === "--out-md") o.outMd = next();
    else if (a === "--no-out") o.noOut = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--self-test") o.selfTest = true;
    else if (a === "--verbose") o.verbose = true;
    else if (a === "-h" || a === "--help") { help(); process.exit(0); }
    else { console.error(`Onbekende optie: ${a}\n`); help(); process.exit(1); }
  }
  return o;
}

// ---------- prompt ----------
function loadSystemPrompt(file, activeWindow) {
  if (!existsSync(file)) {
    console.error(`Prompt-bestand niet gevonden: ${file}`);
    process.exit(1);
  }
  const raw = readFileSync(file, "utf8");
  // Handy stuurt de transcriptie als user-message; ${output} hoort in de
  // systeem-prompt niet thuis. ${active_window} vullen we wel in.
  return raw.replaceAll("${output}", "").replaceAll("${active_window}", activeWindow).trim();
}

// ---------- testcases samenstellen ----------
function buildCases(opts) {
  const langFilter = opts.lang && opts.lang.length ? new Set(opts.lang) : null;
  const deep = DEEP_CASES.filter((c) => !langFilter || langFilter.has(c.lang));
  let cases = [...deep];
  if (!opts.deepOnly) {
    const smokeLangs = opts.allLangs
      ? HANDY_LANGUAGES.map((l) => l.value)
      : (langFilter ? [...langFilter] : CORE_LANGS);
    for (const lang of smokeLangs) {
      const raw = SMOKE_RAW[lang];
      if (!raw) {
        console.error(`Waarschuwing: geen smoke-tekst voor taal "${lang}", overgeslagen.`);
        continue;
      }
      if (deep.some((d) => d.id === `smoke-${lang}`)) continue;
      cases.push({ id: `smoke-${lang}`, lang, cat: "smoke", raw, smoke: true });
    }
  }
  return cases;
}

// ---------- checks evalueren ----------
function evalChecks(test, output) {
  const fails = [];
  const text = output ?? "";
  const trimmed = text.trim();
  if (test.exact !== undefined) {
    if (trimmed !== test.exact) {
      fails.push(`exact: verwacht "${test.exact}", kreeg "${trimmed.slice(0, 120)}"`);
    }
    return fails;
  }
  if (test.smoke) {
    if (trimmed.length < 3) fails.push("smoke: output leeg");
    if (/\bum\b/i.test(trimmed)) fails.push("smoke: filler 'um' niet verwijderd");
    if (/\buh\b/i.test(trimmed)) fails.push("smoke: filler 'uh' niet verwijderd");
    if (/```/.test(trimmed)) fails.push("smoke: markdown code fence in output");
    return fails;
  }
  for (const s of test.contain || []) {
    if (!text.includes(s)) fails.push(`ontbreekt: "${s}"`);
  }
  for (const s of test.notContain || []) {
    if (text.toLowerCase().includes(s.toLowerCase())) fails.push(`verboden string aanwezig: "${s}"`);
  }
  for (const r of test.match || []) {
    if (!new RegExp(r, "m").test(text)) fails.push(`regex match faalt: /${r}/`);
  }
  for (const r of test.notMatch || []) {
    if (new RegExp(r, "m").test(text)) fails.push(`regex had niet mogen matchen: /${r}/`);
  }
  return fails;
}

// ---------- API ----------
async function apiFetch(url, { key, provider, timeoutS, body, method = "GET" }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutS * 1000);
  try {
    const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
    if (provider === "openrouter") {
      headers["HTTP-Referer"] = "https://github.com/MikaKrul/sst-process-bench";
      headers["X-Title"] = "sst-process-bench";
    }
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } finally {
    clearTimeout(t);
  }
}

async function listModels(base, key, provider, timeoutS) {
  const { status, data } = await apiFetch(`${base}/models`, { key, provider, timeoutS });
  if (status !== 200 || !Array.isArray(data.data)) {
    throw new Error(`GET /models faalt (HTTP ${status}): ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data.data.map((m) => m.id).filter(Boolean).sort();
}

async function chatOnce({ base, key, provider, model, system, user, timeoutS }) {
  const body = {
    model,
    temperature: 0,
    max_tokens: 1024,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  // Zelfde als Handy: geen redenering bij OpenRouter, anders vervuilt het de output.
  if (provider === "openrouter") body.reasoning = { effort: "none", exclude: true };
  const started = Date.now();
  const { status, data } = await apiFetch(`${base}/chat/completions`, {
    key, provider, timeoutS, body, method: "POST",
  });
  const ms = Date.now() - started;
  if (status !== 200) {
    const msg = data?.error?.message || JSON.stringify(data).slice(0, 300);
    const err = new Error(`HTTP ${status}: ${msg}`);
    err.retryable = status === 429 || status >= 500;
    throw err;
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("API gaf geen tekst terug");
  return { output: content, ms };
}

async function chatWithRetry(args, retries) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await chatOnce(args);
    } catch (e) {
      last = e;
      if (!e.retryable || attempt === retries) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw last;
}

// ---------- runner met vaste concurrency ----------
async function runPool(items, n, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------- rapport ----------
function pad(s, w) {
  s = String(s);
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}

function renderRanking(modelResults) {
  const rows = [...modelResults].sort(
    (a, b) => b.passRate - a.passRate || a.avgMs - b.avgMs
  );
  const out = [];
  out.push("");
  out.push("RANKING");
  out.push(pad("#", 4) + pad("model", 44) + pad("score", 10) + pad("geslaagd", 12) + pad("gem. ms", 10) + "fouten per categorie");
  out.push("-".repeat(110));
  rows.forEach((r, idx) => {
    const cats = Object.entries(r.failsByCat)
      .map(([k, v]) => `${k}:${v}`)
      .join(" ") || "-";
    out.push(
      pad(idx + 1, 4) +
      pad(r.model, 44) +
      pad((r.passRate * 100).toFixed(1) + "%", 10) +
      pad(`${r.passed}/${r.total}`, 12) +
      pad(Math.round(r.avgMs), 10) +
      cats
    );
  });
  return { text: out.join("\n"), rows };
}

function renderFailures(modelResults, verbose) {
  const out = [];
  for (const r of modelResults) {
    const bad = r.details.filter((d) => d.fails.length > 0 || d.error);
    if (!bad.length) continue;
    out.push(`\n--- ${r.model}: ${bad.length} foute test(s) ---`);
    for (const d of bad.slice(0, verbose ? bad.length : 15)) {
      out.push(`  [${d.test.id}] (${d.test.lang}/${d.test.cat})`);
      if (d.error) out.push(`    ERROR: ${d.error}`);
      else {
        for (const f of d.fails) out.push(`    - ${f}`);
        out.push(`    output: "${(d.output || "").trim().slice(0, 160).replaceAll("\n", "\\n")}"`);
      }
    }
    if (!verbose && bad.length > 15) out.push(`  ... en ${bad.length - 15} meer (gebruik --verbose)`);
  }
  return out.join("\n");
}

function renderMarkdown(rows, modelResults, meta) {
  const lines = [];
  lines.push(`# sst-process-bench resultaat`);
  lines.push(``);
  lines.push(`Datum: ${meta.date} · Provider: ${meta.provider} · Prompt: \`${meta.promptFile}\` · Talen: ${meta.langs} · Tests per model: ${meta.testsPerModel}`);
  lines.push(``);
  lines.push(`| # | Model | Score | Geslaagd | Gem. latency |`);
  lines.push(`|---|-------|-------|----------|--------------|`);
  rows.forEach((r, i) => {
    lines.push(`| ${i + 1} | \`${r.model}\` | ${(r.passRate * 100).toFixed(1)}% | ${r.passed}/${r.total} | ${Math.round(r.avgMs)} ms |`);
  });
  lines.push(``);
  for (const r of rows) {
    const bad = r.details.filter((d) => d.fails.length > 0 || d.error);
    lines.push(`## ${r.model} (${(r.passRate * 100).toFixed(1)}%)`);
    if (!bad.length) { lines.push(`Alle tests geslaagd.`); lines.push(``); continue; }
    for (const d of bad) {
      lines.push(`- [${d.test.id}] (${d.test.lang}/${d.test.cat}): ${(d.error || d.fails.join("; ")).slice(0, 300)}`);
    }
    lines.push(``);
  }
  return lines.join("\n");
}

// ---------- self-test (offline) ----------
function selfTest() {
  const fake = [
    [{ contain: ["Hallo"], notContain: ["um"] }, "Hallo, hoe gaat het?", []],
    [{ contain: ["€5"], notContain: ["vijf"] }, "Dat kost 5 euro.", ['ontbreekt: "€5"']],
    [{ exact: "NULL" }, "NULL\n", []],
    [{ exact: "NULL" }, "Hier is NULL", ['exact: verwacht "NULL", kreeg "Hier is NULL"']],
    [{ smoke: true }, "Hallo, hoe gaat het?", []],
    [{ smoke: true }, "um hallo ```code```", ["smoke: filler 'um' niet verwijderd", "smoke: markdown code fence in output"]],
  ];
  let ok = 0;
  for (const [test, output, wantSub] of fake) {
    const got = evalChecks(test, output);
    const pass = wantSub.length === got.length && wantSub.every((w, i) => got[i] && got[i].includes(w.split(":")[0]));
    console.log(`${pass ? "PASS" : "FAIL"}  ${JSON.stringify(test)} -> ${JSON.stringify(got)}`);
    if (pass) ok++;
  }
  console.log(`\nself-test: ${ok}/${fake.length} geslaagd`);
  process.exit(ok === fake.length ? 0 : 1);
}

// ---------- main ----------
async function main() {
  const o = parseArgs(process.argv);
  if (o.selfTest) return selfTest();

  const providerName = o.provider
    || Object.keys(PROVIDERS).find((p) => process.env[PROVIDERS[p].env])
    || "groq";
  const prov = PROVIDERS[providerName];
  if (!prov) { console.error(`Onbekende provider: ${o.provider}`); process.exit(1); }
  const base = (o.baseUrl || prov.base).replace(/\/$/, "");

  // API-key: flag > bestand > env
  let key = o.apiKey
    || (o.apiKeyFile ? readFileSync(o.apiKeyFile, "utf8").trim() : null)
    || process.env[prov.env]
    || "";
  if (!key && !o.dryRun) {
    console.error(`Geen API-key. Zet ${prov.env}, of gebruik --api-key / --api-key-file.\nVoorbeeld (PowerShell): $env:${prov.env}="gsk-..."; node bench.mjs --provider ${providerName}`);
    process.exit(1);
  }

  const system = loadSystemPrompt(o.promptFile, o.activeWindow);
  const cases = buildCases(o);
  if (!cases.length) { console.error("Geen testcases na taalfilters."); process.exit(1); }

  // Modellen bepalen
  let models = o.models || [];
  if (o.listModels || o.all || !models.length) {
    if (!key) { console.error("Zonder key kan ik /models niet opvragen; geef --models op."); process.exit(1); }
    try {
      const discovered = await listModels(base, key, providerName, o.timeout);
      if (o.listModels) {
        console.log(`Modellen bij ${providerName} (${discovered.length}):`);
        for (const m of discovered) console.log(`  ${m}`);
        return;
      }
      models = o.all ? discovered : discovered.filter((m) => prov.fallbackModels.includes(m));
      if (!models.length) {
        console.error("Geen modellen gevonden; geef expliciet --models op.");
        process.exit(1);
      }
    } catch (e) {
      if (o.listModels) { console.error(String(e.message || e)); process.exit(1); }
      if (!models.length && prov.fallbackModels.length) {
        console.error(`Let op: /models faalt (${e.message}); ik val terug op defaults.`);
        models = prov.fallbackModels;
      } else if (!models.length) {
        console.error(`Kan modellen niet ophalen: ${e.message}; geef --models op.`);
        process.exit(1);
      }
    }
  }

  const plan = `${models.length} model(len) x ${cases.length} tests = ${models.length * cases.length} calls`;
  console.log(`sst-process-bench v${VERSION} | provider=${providerName} | ${plan}`);
  console.log(`Talen: ${[...new Set(cases.map((c) => c.lang))].join(", ")}`);
  if (o.dryRun) {
    for (const m of models) console.log(`  model: ${m}`);
    for (const c of cases) console.log(`  test: ${c.id} [${c.lang}/${c.cat}]`);
    return;
  }

  const modelResults = [];
  for (const model of models) {
    process.stdout.write(`\n[${model}] ... `);
    const details = await runPool(cases, o.concurrency, async (test) => {
      const activeWin = test.activeWindow || o.activeWindow;
      const sys = activeWin === o.activeWindow
        ? system
        : loadSystemPrompt(o.promptFile, activeWin);
      try {
        const { output, ms } = await chatWithRetry(
          { base, key, provider: providerName, model, system: sys, user: test.raw, timeoutS: o.timeout },
          o.retries
        );
        const fails = evalChecks(test, output);
        if (o.verbose) {
          console.log(`\n  [${test.id}] ${fails.length ? "FAIL" : "PASS"} (${ms}ms): "${output.trim().slice(0, 120).replaceAll("\n", "\\n")}"`);
          for (const f of fails) console.log(`    - ${f}`);
        }
        return { test, output, ms, fails, error: null };
      } catch (e) {
        return { test, output: "", ms: 0, fails: [], error: String(e.message || e) };
      }
    });
    const passed = details.filter((d) => !d.error && d.fails.length === 0).length;
    const lat = details.filter((d) => !d.error).map((d) => d.ms);
    const failsByCat = {};
    for (const d of details) {
      if (d.error || d.fails.length) {
        failsByCat[d.test.cat] = (failsByCat[d.test.cat] || 0) + 1;
      }
    }
    const r = {
      model,
      passed,
      total: details.length,
      passRate: details.length ? passed / details.length : 0,
      avgMs: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : 0,
      failsByCat,
      details,
    };
    modelResults.push(r);
    process.stdout.write(`${passed}/${details.length} geslaagd`);
  }

  const { text, rows } = renderRanking(modelResults);
  console.log(text);
  console.log(renderFailures(modelResults, o.verbose));

  // Per-taal samenvatting
  const byLang = {};
  for (const r of modelResults) {
    for (const d of r.details) {
      const k = d.test.lang;
      byLang[k] = byLang[k] || { pass: 0, total: 0 };
      byLang[k].total++;
      if (!d.error && !d.fails.length) byLang[k].pass++;
    }
  }
  console.log("\nSCORE PER TAAL (alle modellen samen):");
  for (const [lang, s] of Object.entries(byLang).sort((a, b) => a[1].pass / a[1].total - b[1].pass / b[1].total)) {
    console.log(`  ${pad(lang, 10)} ${(100 * s.pass / s.total).toFixed(1)}% (${s.pass}/${s.total})`);
  }

  if (!o.noOut) {
    const meta = {
      date: new Date().toISOString(),
      provider: providerName,
      base,
      promptFile: o.promptFile,
      langs: Object.keys(byLang).length,
      testsPerModel: cases.length,
    };
    writeFileSync(o.outJson, JSON.stringify({ meta, results: modelResults }, null, 2));
    writeFileSync(o.outMd, renderMarkdown(rows, modelResults, meta));
    console.log(`\nWeggeschreven: ${o.outJson}, ${o.outMd}`);
  }
}

main().catch((e) => {
  console.error(`Fataal: ${e.stack || e.message || e}`);
  process.exit(1);
});
