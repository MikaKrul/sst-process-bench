#!/usr/bin/env node
// Verbatim Bench: benchmark for speech-to-text post-processing models.
// Zero dependencies. Node 18+ stdlib only (fetch, fs, readline, process).
// Works with any OpenAI-compatible API: Groq, OpenRouter, OpenAI, ...

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { HANDY_LANGUAGES, CORE_LANGS } from "./langs.mjs";
import { DEEP_CASES, SMOKE_RAW } from "./cases.mjs";
import { printBanner, createBar, bold, green, red, yellow, dim } from "./brand.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const VERSION = "0.3.0";

const PROVIDERS = {
  groq: {
    base: "https://api.groq.com/openai/v1",
    env: "GROQ_API_KEY",
    fallbackModels: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"],
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

// Model ids that cannot do chat completions (STT, TTS, guard models).
const NON_CHAT = /whisper|orpheus|guard|safeguard/i;

function help() {
  console.log(`Verbatim Bench v${VERSION} — post-processing benchmark (zero dependencies)

USAGE:
  node bench.mjs --provider groq --models openai/gpt-oss-120b
  node bench.mjs --all-providers --all
  node bench.mjs --list-models --provider groq

API KEYS (first hit wins per provider):
  --api-key XXX            passed directly (single-provider runs)
  GROQ_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY / ... as env vars
  --api-key-file PATH      file containing only the key

OPTIONS:
  --provider NAME    ${Object.keys(PROVIDERS).join("|")} (default: auto-detect from env, else groq)
  --providers a,b    run on several providers at once (keys via env vars)
  --all-providers    run on every provider that has a key configured
  --models a,b,c     comma-separated models (single-provider runs only)
  --all              test every chat model found via /models (can be slow)
  --include-non-chat also test STT/TTS/guard models (skipped by default)
  --list-models      show available models and stop
  --lang nl,en,de    only these languages (default: core set of ${CORE_LANGS.length} languages)
  --all-langs        all ${HANDY_LANGUAGES.length} Handy languages (smoke) + all strict tests
  --deep-only        strict tests only, no smoke tests
  --prompt-file F    custom system prompt (default: prompt.txt)
  --active-window S  value for \${active_window} (default: "VS Code")
  --known-models F   snapshot of known model ids (default: models-known.json)
  --yes              accept new models without asking (for CI)
  --concurrency N    parallel requests (default: 3)
  --timeout S        timeout per request in seconds (default: 60)
  --retries N        retries on 429/5xx (default: 3)
  --out-json F       JSON results (default: results.json)
  --out-md F         Markdown ranking (default: results.md)
  --no-out           write no files
  --no-charts        skip regenerating the SVG charts
  --dry-run          show the plan (models x tests) without API calls
  --self-test        offline check of the scoring, no API key needed
  --verbose          show every model output
  -h, --help         this help
`);
}

// ---------- args ----------
function parseArgs(argv) {
  const o = {
    provider: null, providers: null, allProviders: false,
    apiKey: null, apiKeyFile: null, baseUrl: null,
    models: null, all: false, includeNonChat: false, listModels: false,
    lang: null, allLangs: false, deepOnly: false,
    promptFile: join(ROOT, "prompt.txt"),
    activeWindow: "VS Code", knownModels: join(ROOT, "models-known.json"),
    yes: false, concurrency: 3, timeout: 60, retries: 3,
    outJson: "results.json", outMd: "results.md", noOut: false, noCharts: false,
    dryRun: false, selfTest: false, verbose: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? "";
    if (a === "--provider") o.provider = next();
    else if (a === "--providers") o.providers = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--all-providers") o.allProviders = true;
    else if (a === "--api-key") o.apiKey = next();
    else if (a === "--api-key-file") o.apiKeyFile = next();
    else if (a === "--base-url") o.baseUrl = next();
    else if (a === "--models") o.models = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--all") o.all = true;
    else if (a === "--include-non-chat") o.includeNonChat = true;
    else if (a === "--list-models") o.listModels = true;
    else if (a === "--lang") o.lang = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--all-langs") o.allLangs = true;
    else if (a === "--deep-only") o.deepOnly = true;
    else if (a === "--prompt-file") o.promptFile = next();
    else if (a === "--active-window") o.activeWindow = next();
    else if (a === "--known-models") o.knownModels = next();
    else if (a === "--yes") o.yes = true;
    else if (a === "--concurrency") o.concurrency = Math.max(1, parseInt(next(), 10) || 3);
    else if (a === "--timeout") o.timeout = Math.max(5, parseInt(next(), 10) || 60);
    else if (a === "--retries") o.retries = Math.max(0, parseInt(next(), 10) || 0);
    else if (a === "--out-json") o.outJson = next();
    else if (a === "--out-md") o.outMd = next();
    else if (a === "--no-out") o.noOut = true;
    else if (a === "--no-charts") o.noCharts = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--self-test") o.selfTest = true;
    else if (a === "--verbose") o.verbose = true;
    else if (a === "-h" || a === "--help") { help(); process.exit(0); }
    else { console.error(`Unknown option: ${a}\n`); help(); process.exit(1); }
  }
  return o;
}

// ---------- prompt ----------
function loadSystemPrompt(file, activeWindow) {
  if (!existsSync(file)) {
    console.error(`Prompt file not found: ${file}`);
    process.exit(1);
  }
  const raw = readFileSync(file, "utf8");
  // Handy sends the transcript as the user message, so ${output} has no
  // place in the system prompt. ${active_window} does get filled in.
  return raw.replaceAll("${output}", "").replaceAll("${active_window}", activeWindow).trim();
}

// ---------- test cases ----------
function buildCases(opts) {
  const langFilter = opts.lang && opts.lang.length ? new Set(opts.lang) : null;
  const deep = DEEP_CASES.filter((c) => !langFilter || langFilter.has(c.lang));
  const cases = [...deep];
  if (!opts.deepOnly) {
    const smokeLangs = opts.allLangs
      ? HANDY_LANGUAGES.map((l) => l.value)
      : (langFilter ? [...langFilter] : CORE_LANGS);
    for (const lang of smokeLangs) {
      const raw = SMOKE_RAW[lang];
      if (!raw) {
        console.error(`Warning: no smoke text for language "${lang}", skipped.`);
        continue;
      }
      cases.push({ id: `smoke-${lang}`, lang, cat: "smoke", raw, smoke: true });
    }
  }
  return cases;
}

// ---------- check evaluation ----------
function evalChecks(test, output) {
  const fails = [];
  const text = output ?? "";
  const trimmed = text.trim();
  if (test.exact !== undefined) {
    if (trimmed !== test.exact) {
      fails.push(`exact: expected "${test.exact}", got "${trimmed.slice(0, 120)}"`);
    }
    return fails;
  }
  if (test.smoke) {
    if (trimmed.length < 3) fails.push("smoke: output empty");
    if (/\bum\b/i.test(trimmed)) fails.push("smoke: filler 'um' not removed");
    if (/\buh\b/i.test(trimmed)) fails.push("smoke: filler 'uh' not removed");
    if (/```/.test(trimmed)) fails.push("smoke: code fence in output");
    return fails;
  }
  for (const s of test.contain || []) {
    if (!text.toLowerCase().includes(s.toLowerCase())) fails.push(`missing: "${s}"`);
  }
  for (const s of test.notContain || []) {
    if (text.toLowerCase().includes(s.toLowerCase())) fails.push(`forbidden string present: "${s}"`);
  }
  for (const r of test.match || []) {
    if (!new RegExp(r, "m").test(text)) fails.push(`regex failed: /${r}/`);
  }
  for (const r of test.notMatch || []) {
    if (new RegExp(r, "m").test(text)) fails.push(`regex should not match: /${r}/`);
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
      headers["X-Title"] = "Verbatim Bench";
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
    throw new Error(`GET /models failed (HTTP ${status}): ${JSON.stringify(data).slice(0, 200)}`);
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
  // Same as Handy: no reasoning on OpenRouter, or it pollutes the output.
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
  if (typeof content !== "string") throw new Error("API returned no text");
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
      // Providers often ask to wait a few seconds; back off 3s, 6s, 12s, ...
      await new Promise((r) => setTimeout(r, 1000 * 3 * 2 ** attempt));
    }
  }
  throw last;
}

// ---------- runner with fixed concurrency ----------
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

function askYesNo(question) {
  if (!process.stdin.isTTY) {
    console.log(`${question} (no TTY, answering no; use --yes to accept)`);
    return Promise.resolve(false);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

// ---------- reporting ----------
function pad(s, w) {
  s = String(s);
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}

function modelLabel(r, multi) {
  return multi ? `${r.provider}/${r.model}` : r.model;
}

function renderRanking(modelResults) {
  const multi = new Set(modelResults.map((r) => r.provider)).size > 1;
  const rows = [...modelResults].sort(
    (a, b) => b.passRate - a.passRate || a.avgMs - b.avgMs
  );
  const out = [];
  out.push("");
  out.push(bold("FINAL RANKING"));
  out.push(pad("#", 4) + pad("model", 44) + pad("score", 10) + pad("passed", 12) + pad("avg ms", 10) + "failing categories");
  out.push("-".repeat(110));
  rows.forEach((r, idx) => {
    const cats = Object.entries(r.failsByCat)
      .map(([k, v]) => `${k}:${v}`)
      .join(" ") || "-";
    out.push(
      pad(idx + 1, 4) +
      pad(modelLabel(r, multi), 44) +
      pad((r.passRate * 100).toFixed(1) + "%", 10) +
      pad(`${r.passed}/${r.total}`, 12) +
      pad(Math.round(r.avgMs), 10) +
      cats
    );
  });
  return { text: out.join("\n"), rows, multi };
}

function renderInterim(finished, total) {
  const rows = [...finished].sort((a, b) => b.passRate - a.passRate);
  const parts = rows.map(
    (r, i) => `${i + 1}. ${r.provider}/${r.model} ${(r.passRate * 100).toFixed(1)}%`
  );
  return `Interim (${finished.length}/${total} done): ${parts.join(" · ")}`;
}

function renderFailures(modelResults, verbose) {
  const out = [];
  for (const r of modelResults) {
    const bad = r.details.filter((d) => d.fails.length > 0 || d.error);
    if (!bad.length) continue;
    out.push(`\n--- ${r.provider}/${r.model}: ${bad.length} failed test(s) ---`);
    for (const d of bad.slice(0, verbose ? bad.length : 15)) {
      out.push(`  [${d.test.id}] (${d.test.lang}/${d.test.cat})`);
      if (d.error) out.push(`    ERROR: ${d.error}`);
      else {
        for (const f of d.fails) out.push(`    - ${f}`);
        out.push(`    output: "${(d.output || "").trim().slice(0, 160).replaceAll("\n", "\\n")}"`);
      }
    }
    if (!verbose && bad.length > 15) out.push(`  ... and ${bad.length - 15} more (use --verbose)`);
  }
  return out.join("\n");
}

function renderMarkdown(rows, modelResults, meta, multi) {
  const lines = [];
  lines.push(`# Verbatim Bench results`);
  lines.push(``);
  lines.push(`Date: ${meta.date} · Providers: ${meta.providers.join(", ")} · Prompt: \`prompt.txt\` · Languages: ${meta.langs} · Tests per model: ${meta.testsPerModel}`);
  lines.push(``);
  lines.push(`| # | Model | Score | Passed | Avg latency |`);
  lines.push(`|---|-------|-------|--------|-------------|`);
  rows.forEach((r, i) => {
    lines.push(`| ${i + 1} | \`${modelLabel(r, multi)}\` | ${(r.passRate * 100).toFixed(1)}% | ${r.passed}/${r.total} | ${Math.round(r.avgMs)} ms |`);
  });
  lines.push(``);
  for (const r of rows) {
    const bad = r.details.filter((d) => d.fails.length > 0 || d.error);
    lines.push(`## ${modelLabel(r, multi)} (${(r.passRate * 100).toFixed(1)}%)`);
    if (!bad.length) { lines.push(`All tests passed.`); lines.push(``); continue; }
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
    [{ contain: ["Hello"], notContain: ["um"] }, "Hello, how are you?", []],
    [{ contain: ["€5"], notContain: ["vijf"] }, "Dat kost 5 euro.", ['missing: "€5"']],
    [{ exact: "NULL" }, "NULL\n", []],
    [{ exact: "NULL" }, "Here is NULL", ['exact: expected "NULL", got "Here is NULL"']],
    [{ smoke: true }, "Hello, how are you?", []],
    [{ smoke: true }, "um hello ```code```", ["smoke: filler 'um' not removed", "smoke: code fence in output"]],
  ];
  let ok = 0;
  for (const [test, output, wantSub] of fake) {
    const got = evalChecks(test, output);
    const pass = wantSub.length === got.length && wantSub.every((w, i) => got[i] && got[i].includes(w.split(":")[0]));
    console.log(`${pass ? "PASS" : "FAIL"}  ${JSON.stringify(test)} -> ${JSON.stringify(got)}`);
    if (pass) ok++;
  }
  console.log(`\nself-test: ${ok}/${fake.length} passed`);
  process.exit(ok === fake.length ? 0 : 1);
}

// ---------- main ----------
async function main() {
  const o = parseArgs(process.argv);
  if (o.selfTest) return selfTest();

  // Which providers? Explicit flags win, otherwise auto-detect from env.
  let wanted;
  if (o.provider) wanted = [o.provider];
  else if (o.providers) wanted = o.providers;
  else if (o.allProviders) wanted = Object.keys(PROVIDERS).filter((p) => process.env[PROVIDERS[p].env]);
  else {
    wanted = [Object.keys(PROVIDERS).find((p) => process.env[PROVIDERS[p].env]) || "groq"];
  }
  for (const p of wanted) {
    if (!PROVIDERS[p]) { console.error(`Unknown provider: ${p}`); process.exit(1); }
  }
  if (!wanted.length) {
    console.error("No providers selected. --all-providers found no configured keys; set one (e.g. GROQ_API_KEY) or use --provider.");
    process.exit(1);
  }
  if (o.models && wanted.length > 1) {
    console.error("--models only works with a single provider; omit it to use defaults per provider.");
    process.exit(1);
  }

  // Resolve keys: flag > file > env.
  const keyFromFlag = o.apiKey || (o.apiKeyFile ? readFileSync(o.apiKeyFile, "utf8").trim() : null);
  const providers = wanted.map((name) => ({
    name,
    base: (o.baseUrl && wanted.length === 1 ? o.baseUrl : PROVIDERS[name].base).replace(/\/$/, ""),
    key: wanted.length === 1 && keyFromFlag ? keyFromFlag : (process.env[PROVIDERS[name].env] || ""),
  }));

  const system = loadSystemPrompt(o.promptFile, o.activeWindow);
  const cases = buildCases(o);
  if (!cases.length) { console.error("No test cases left after language filters."); process.exit(1); }

  // Validate every key and discover models.
  console.log(bold("KEY CHECK"));
  const jobs = [];
  for (const p of providers) {
    if (o.dryRun) {
      console.log(`  ${dim("SKIP")}  ${p.name}: dry run, key not tested`);
      jobs.push({ ...p, discovered: [], keyOk: false });
      continue;
    }
    if (!p.key) {
      console.log(`  ${red("FAIL")}  ${p.name}: no key (set ${PROVIDERS[p.name].env} or use --api-key)`);
      continue;
    }
    try {
      const discovered = await listModels(p.base, p.key, p.name, o.timeout);
      const chat = o.includeNonChat ? discovered : discovered.filter((m) => !NON_CHAT.test(m));
      console.log(`  ${green("OK")}    ${p.name}: key works, ${discovered.length} models (${chat.length} chat)`);
      jobs.push({ ...p, discovered, keyOk: true });
    } catch (e) {
      console.log(`  ${red("FAIL")}  ${p.name}: ${e.message}`);
      jobs.push({ ...p, discovered: [], keyOk: false });
    }
  }

  if (o.listModels) {
    for (const j of jobs) {
      if (!j.keyOk) continue;
      console.log(`\nModels at ${j.name} (${j.discovered.length}):`);
      for (const m of j.discovered) {
        console.log(`  ${m}${NON_CHAT.test(m) ? dim("  (non-chat, skipped unless --include-non-chat)") : ""}`);
      }
    }
    return;
  }

  const live = o.dryRun ? jobs : jobs.filter((j) => j.keyOk);
  if (!live.length && !o.dryRun) {
    console.error("No working API key. Set it via env var, --api-key or --api-key-file.");
    console.error(`Example (PowerShell): $env:${PROVIDERS[wanted[0]].env}="..."; node bench.mjs --provider ${wanted[0]}`);
    process.exit(1);
  }

  // Pick models per provider, checking for new ones first.
  let known = {};
  if (existsSync(o.knownModels)) {
    try { known = JSON.parse(readFileSync(o.knownModels, "utf8")); } catch { known = {}; }
  }
  let knownChanged = false;
  const plan = [];
  for (const j of live) {
    const chat = (o.includeNonChat ? j.discovered : j.discovered.filter((m) => !NON_CHAT.test(m)));
    let models;
    if (o.models) {
      models = o.models;
    } else if (o.all || o.dryRun) {
      models = o.dryRun && !j.keyOk ? PROVIDERS[j.name].fallbackModels : chat;
    } else {
      models = PROVIDERS[j.name].fallbackModels.filter((m) => chat.includes(m));
      if (!models.length && chat.length && !o.dryRun) {
        console.log(`Note: none of the default models for ${j.name} are online; use --models or --all.`);
      }
    }
    const knownIds = new Set(known[j.name] || []);
    const fresh = chat.filter((m) => !knownIds.has(m));
    if (fresh.length && !o.dryRun) {
      console.log(`\n${yellow(`${fresh.length} new model(s) at ${j.name} since last check:`)}`);
      for (const m of fresh) console.log(`  + ${m}`);
      let accept = o.all || o.yes;
      if (!accept) accept = await askYesNo(`Test the new model(s) too?`);
      if (accept && !o.models) {
        models = [...new Set([...models, ...fresh])];
        console.log(`Added ${fresh.length} new model(s) to this run.`);
      }
    }
    for (const m of chat) {
      if (!knownIds.has(m)) { knownIds.add(m); knownChanged = true; }
    }
    known[j.name] = [...knownIds].sort();
    if (o.dryRun && !models.length) models = PROVIDERS[j.name].fallbackModels;
    for (const m of models) plan.push({ provider: j.name, base: j.base, key: j.key, model: m });
  }
  if (knownChanged && !o.noOut && !o.dryRun) {
    writeFileSync(o.knownModels, JSON.stringify(known, null, 2) + "\n");
  }
  if (!plan.length) { console.error("No models to test. Pass --models or --all."); process.exit(1); }

  const planText = `${plan.length} run(s): ${[...new Set(plan.map((p) => p.provider))].join(", ")} x ${cases.length} tests`;
  printBanner(VERSION, planText);
  console.log(`Languages: ${[...new Set(cases.map((c) => c.lang))].join(", ")}`);
  if (o.dryRun) {
    for (const p of plan) console.log(`  ${p.provider}/${p.model}`);
    for (const c of cases) console.log(`  test: ${c.id} [${c.lang}/${c.cat}]`);
    return;
  }

  const modelResults = [];
  for (const p of plan) {
    const bar = createBar(`${p.provider}/${p.model}`, cases.length, o.verbose);
    const details = await runPool(cases, o.concurrency, async (test) => {
      const sys = test.activeWindow && test.activeWindow !== o.activeWindow
        ? loadSystemPrompt(o.promptFile, test.activeWindow)
        : system;
      try {
        const { output, ms } = await chatWithRetry(
          { base: p.base, key: p.key, provider: p.provider, model: p.model, system: sys, user: test.raw, timeoutS: o.timeout },
          o.retries
        );
        const fails = evalChecks(test, output);
        const detail = { test, output, ms, fails, error: null };
        bar.tick(detail);
        if (o.verbose) {
          console.log(`\n  [${test.id}] ${fails.length ? "FAIL" : "PASS"} (${ms}ms): "${output.trim().slice(0, 120).replaceAll("\n", "\\n")}"`);
          for (const f of fails) console.log(`    - ${f}`);
        }
        return detail;
      } catch (e) {
        const detail = { test, output: "", ms: 0, fails: [], error: String(e.message || e) };
        bar.tick(detail);
        return detail;
      }
    });
    bar.done();
    const passed = details.filter((d) => !d.error && d.fails.length === 0).length;
    const lat = details.filter((d) => !d.error).map((d) => d.ms);
    const failsByCat = {};
    for (const d of details) {
      if (d.error || d.fails.length) {
        failsByCat[d.test.cat] = (failsByCat[d.test.cat] || 0) + 1;
      }
    }
    modelResults.push({
      provider: p.provider,
      model: p.model,
      passed,
      total: details.length,
      passRate: details.length ? passed / details.length : 0,
      avgMs: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : 0,
      failsByCat,
      details,
    });
    console.log(renderInterim(modelResults, plan.length));
  }

  const { text, rows, multi } = renderRanking(modelResults);
  console.log(text);
  console.log(renderFailures(modelResults, o.verbose));

  const byLang = {};
  for (const r of modelResults) {
    for (const d of r.details) {
      const k = d.test.lang;
      byLang[k] = byLang[k] || { pass: 0, total: 0 };
      byLang[k].total++;
      if (!d.error && !d.fails.length) byLang[k].pass++;
    }
  }
  console.log("\n" + bold("SCORE PER LANGUAGE (all models combined):"));
  for (const [lang, s] of Object.entries(byLang).sort((a, b) => a[1].pass / a[1].total - b[1].pass / b[1].total)) {
    console.log(`  ${pad(lang, 10)} ${(100 * s.pass / s.total).toFixed(1)}% (${s.pass}/${s.total})`);
  }

  if (!o.noOut) {
    const meta = {
      date: new Date().toISOString(),
      providers: [...new Set(modelResults.map((r) => r.provider))],
      promptFile: "prompt.txt",
      langs: Object.keys(byLang).length,
      testsPerModel: cases.length,
    };
    writeFileSync(o.outJson, JSON.stringify({ meta, results: modelResults }, null, 2));
    writeFileSync(o.outMd, renderMarkdown(rows, modelResults, meta, multi));
    console.log(`\nWritten: ${o.outJson}, ${o.outMd}`);
    if (!o.noCharts) {
      const { generateCharts } = await import("./chart.mjs");
      const files = generateCharts(o.outJson);
      console.log(`Charts: ${files.join(", ")}`);
    }
  }
}

main().catch((e) => {
  console.error(`Fatal: ${e.stack || e.message || e}`);
  process.exit(1);
});
