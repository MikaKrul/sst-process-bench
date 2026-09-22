// Branding and progress for Verbatim Bench. Zero dependencies, only ANSI codes
// from the Node stdlib. Color is only on for a real terminal (no pipe)
// and respects NO_COLOR.
export const NAME = "Verbatim Bench";
export const TAGLINE = "do models follow the rules?";

const TTY = process.stdout.isTTY === true;
const NO_COLOR = "NO_COLOR" in process.env;
export const USE_COLOR = TTY && !NO_COLOR;

const wrap = (code) => (s) => (USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = wrap(1);
export const dim = wrap(2);
export const green = wrap(32);
export const yellow = wrap(33);
export const red = wrap(31);
export const cyan = wrap(36);

export function printBanner(version, plan) {
  const W = 52;
  const row = (text, style) => {
    const pad = Math.max(0, W - text.length);
    console.log(cyan("\u2502") + style(text + " ".repeat(pad)) + cyan("\u2502"));
  };
  console.log(cyan("\u250C" + "\u2500".repeat(W) + "\u2510"));
  row(`  VERBATIM BENCH  v${version}`, bold);
  row(`  transcript-cleaning benchmark`, dim);
  row(`  ${plan}`, dim);
  console.log(cyan("\u2514" + "\u2500".repeat(W) + "\u2518"));
}

// Live progress bar per model. In a real terminal it rewrites the same line,
// when piped or with --verbose it prints plain lines instead.
export function createBar(label, total, plain = false) {
  const W = 24;
  const live = TTY && !plain;
  const short = label.length > 28 ? label.slice(0, 27) + "\u2026" : label;
  let done = 0;
  let pass = 0;
  let fail = 0;
  let errors = 0;
  let lastLen = 0;
  const t0 = Date.now();

  function render() {
    const frac = total ? done / total : 1;
    const fill = Math.round(W * frac);
    const bar = "\u2588".repeat(fill) + "\u2591".repeat(W - fill);
    const el = `${Math.round((Date.now() - t0) / 1000)}s`;
    const failPart = fail + errors > 0 ? red(`${fail + errors} failed`) : dim("0 failed");
    return `[${short}] ${bar} ${done}/${total} \u00B7 ${green(`${pass} ok`)} \u00B7 ${failPart} \u00B7 ${el}`;
  }

  function show(force) {
    const line = render();
    if (live) {
      const padded = line + " ".repeat(Math.max(0, lastLen - line.length));
      lastLen = line.length;
      process.stdout.write("\r" + padded);
    } else if (force || done === total || done % 10 === 0) {
      console.log(line);
    }
  }

  return {
    tick(detail) {
      done++;
      if (detail.error) errors++;
      else if (detail.fails.length) fail++;
      else pass++;
      const interesting = detail.error || detail.fails.length > 0;
      show(interesting);
    },
    done() {
      show(true);
      if (live) process.stdout.write("\n");
      return { done, pass, fail, errors };
    },
  };
}
