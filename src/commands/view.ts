/**
 * `evalguard view` — Open a local web UI to browse eval/scan results
 * Starts an HTTP server and opens the browser automatically.
 * Reads from ~/.evalguard/results.json (stored runs) and local result files.
 */
import { Command } from "commander";
import chalk from "chalk";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { exec } from "node:child_process";
import { listRuns, getRun, type StoredRun } from "./store.js";

// ─── HTML Template ──────────────────────────────────────────────────────────

/** Exported for the XSS regression test (see __tests__/view-xss.test.ts). */
export function buildHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>EvalGuard Viewer</title>
<style>
  :root {
    --bg: #0c0a13;
    --bg-card: #151221;
    --bg-hover: #1c1832;
    --border: #2a2545;
    --text: #e4e2ed;
    --text-dim: #8b87a0;
    --accent: #8b5cf6;
    --accent-dim: #6d45d1;
    --green: #22c55e;
    --green-dim: #15803d;
    --red: #ef4444;
    --red-dim: #991b1b;
    --yellow: #eab308;
    --yellow-dim: #a16207;
    --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --mono: "SF Mono", "Cascadia Code", "Fira Code", Consolas, monospace;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: var(--font);
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
  }

  /* ── Header ── */
  header {
    background: linear-gradient(135deg, #1a1530 0%, #0f0b20 100%);
    border-bottom: 1px solid var(--border);
    padding: 20px 32px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .logo {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 20px;
    font-weight: 700;
    color: #fff;
  }
  .logo-icon {
    width: 32px;
    height: 32px;
    background: linear-gradient(135deg, var(--accent), #a78bfa);
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    color: #fff;
  }
  .header-meta {
    color: var(--text-dim);
    font-size: 13px;
  }

  /* ── Layout ── */
  .container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 24px 32px;
  }

  /* ── Stats bar ── */
  .stats-bar {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 16px;
    margin-bottom: 28px;
  }
  .stat-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
  }
  .stat-label {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
    margin-bottom: 6px;
  }
  .stat-value {
    font-size: 28px;
    font-weight: 700;
  }
  .stat-value.green { color: var(--green); }
  .stat-value.red { color: var(--red); }
  .stat-value.yellow { color: var(--yellow); }
  .stat-value.accent { color: var(--accent); }

  /* ── Tabs ── */
  .tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 20px;
    border-bottom: 1px solid var(--border);
    padding-bottom: 0;
  }
  .tab {
    padding: 10px 20px;
    cursor: pointer;
    border: none;
    background: transparent;
    color: var(--text-dim);
    font-size: 14px;
    font-weight: 500;
    border-bottom: 2px solid transparent;
    transition: all 0.15s;
    font-family: var(--font);
  }
  .tab:hover { color: var(--text); }
  .tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  /* ── Run list ── */
  .run-list { display: flex; flex-direction: column; gap: 8px; }
  .run-row {
    display: grid;
    grid-template-columns: 36px 1fr 100px 80px 120px 160px;
    align-items: center;
    gap: 12px;
    padding: 14px 18px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 10px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .run-row:hover {
    background: var(--bg-hover);
    border-color: var(--accent-dim);
  }
  .run-row.selected {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .run-icon {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: 700;
  }
  .run-icon.pass { background: var(--green-dim); color: var(--green); }
  .run-icon.fail { background: var(--red-dim); color: var(--red); }
  .run-icon.warn { background: var(--yellow-dim); color: var(--yellow); }
  .run-name { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .run-rate { font-weight: 600; font-size: 14px; text-align: right; }
  .run-counts { font-size: 13px; color: var(--text-dim); text-align: right; }
  .run-model { font-size: 12px; color: var(--text-dim); font-family: var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .run-date { font-size: 12px; color: var(--text-dim); text-align: right; }

  /* ── Detail panel ── */
  .detail-panel {
    margin-top: 24px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
  }
  .detail-header {
    padding: 20px 24px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .detail-title {
    font-size: 18px;
    font-weight: 700;
  }
  .detail-meta {
    display: flex;
    gap: 16px;
    font-size: 13px;
    color: var(--text-dim);
  }
  .badge {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 100px;
    font-size: 12px;
    font-weight: 600;
  }
  .badge.pass { background: var(--green-dim); color: var(--green); }
  .badge.fail { background: var(--red-dim); color: var(--red); }
  .badge.warn { background: var(--yellow-dim); color: var(--yellow); }
  .badge.type { background: rgba(139,92,246,0.15); color: var(--accent); }

  /* ── Score breakdown ── */
  .score-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    padding: 20px 24px;
    border-bottom: 1px solid var(--border);
  }
  .score-item {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .score-item-label { font-size: 12px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; }
  .score-item-value { font-size: 20px; font-weight: 700; }
  .progress-bar {
    height: 6px;
    background: var(--border);
    border-radius: 3px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    border-radius: 3px;
    transition: width 0.4s ease;
  }

  /* ── Case table ── */
  .case-table {
    width: 100%;
    border-collapse: collapse;
  }
  .case-table th {
    text-align: left;
    padding: 12px 16px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
    background: rgba(0,0,0,0.2);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
  }
  .case-table td {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    vertical-align: top;
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .case-table tr:last-child td { border-bottom: none; }
  .case-table tr:hover td { background: rgba(139,92,246,0.04); }
  .case-pass { color: var(--green); font-weight: 600; }
  .case-fail { color: var(--red); font-weight: 600; }
  .case-score { font-family: var(--mono); font-size: 12px; }
  .case-text {
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 80px;
    overflow-y: auto;
    font-size: 12px;
    line-height: 1.5;
  }

  /* ── Empty state ── */
  .empty {
    text-align: center;
    padding: 80px 20px;
    color: var(--text-dim);
  }
  .empty-icon { font-size: 48px; margin-bottom: 16px; opacity: 0.4; }
  .empty-title { font-size: 18px; font-weight: 600; color: var(--text); margin-bottom: 8px; }
  .empty-hint { font-size: 14px; }
  .empty code {
    background: rgba(139,92,246,0.15);
    color: var(--accent);
    padding: 2px 8px;
    border-radius: 4px;
    font-family: var(--mono);
    font-size: 13px;
  }

  /* ── Scrollbar ── */
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--text-dim); }

  /* ── Responsive ── */
  @media (max-width: 768px) {
    .container { padding: 16px; }
    .run-row { grid-template-columns: 32px 1fr 80px; }
    .run-model, .run-date, .run-counts { display: none; }
    .stats-bar { grid-template-columns: repeat(2, 1fr); }
  }
</style>
</head>
<body>
<header>
  <div class="logo">
    <div class="logo-icon">E</div>
    <span>EvalGuard <span style="color:var(--text-dim);font-weight:400;font-size:14px">Viewer</span></span>
  </div>
  <div class="header-meta" id="header-meta">Loading...</div>
</header>

<div class="container">
  <div class="stats-bar" id="stats-bar"></div>

  <div class="tabs" id="tabs">
    <button class="tab active" data-tab="all">All Runs</button>
    <button class="tab" data-tab="eval">Evals</button>
    <button class="tab" data-tab="scan">Scans</button>
  </div>

  <div id="run-list" class="run-list"></div>
  <div id="detail-panel"></div>
</div>

<script>
  let runs = [];
  let selectedRunId = null;
  let currentTab = 'all';

  async function fetchRuns() {
    const res = await fetch('/api/runs');
    runs = await res.json();
    render();
  }

  function getFiltered() {
    if (currentTab === 'all') return runs;
    return runs.filter(r => r.type === currentTab);
  }

  function rateColor(rate) {
    if (rate >= 0.8) return 'green';
    if (rate >= 0.5) return 'yellow';
    return 'red';
  }

  function renderStats() {
    const f = getFiltered();
    const total = f.length;
    const avgPass = total ? f.reduce((s, r) => s + r.passRate, 0) / total : 0;
    const totalPassed = f.reduce((s, r) => s + r.passed, 0);
    const totalFailed = f.reduce((s, r) => s + r.failed, 0);
    const avgLatency = total ? Math.round(f.reduce((s, r) => s + r.latencyMs, 0) / total) : 0;

    document.getElementById('stats-bar').innerHTML =
      '<div class="stat-card"><div class="stat-label">Total Runs</div><div class="stat-value accent">' + total + '</div></div>' +
      '<div class="stat-card"><div class="stat-label">Avg Pass Rate</div><div class="stat-value ' + rateColor(avgPass) + '">' + (avgPass * 100).toFixed(1) + '%</div></div>' +
      '<div class="stat-card"><div class="stat-label">Total Passed</div><div class="stat-value green">' + totalPassed + '</div></div>' +
      '<div class="stat-card"><div class="stat-label">Total Failed</div><div class="stat-value red">' + totalFailed + '</div></div>' +
      '<div class="stat-card"><div class="stat-label">Avg Latency</div><div class="stat-value" style="color:var(--text)">' + avgLatency + 'ms</div></div>';

    document.getElementById('header-meta').textContent = total + ' run' + (total !== 1 ? 's' : '') + ' stored in ~/.evalguard/';
  }

  function renderList() {
    const f = getFiltered();
    const el = document.getElementById('run-list');

    if (f.length === 0) {
      el.innerHTML =
        '<div class="empty">' +
          '<div class="empty-icon">&#x1F50D;</div>' +
          '<div class="empty-title">No runs found</div>' +
          '<div class="empty-hint">Run an eval first: <code>npx @evalguard/cli eval --local</code></div>' +
        '</div>';
      return;
    }

    el.innerHTML = f.map(r => {
      const rc = rateColor(r.passRate);
      const iconClass = rc === 'green' ? 'pass' : rc === 'red' ? 'fail' : 'warn';
      const iconChar = rc === 'green' ? '&#10003;' : rc === 'red' ? '&#10007;' : '!';
      const d = new Date(r.timestamp);
      const dateStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
      const sel = r.id === selectedRunId ? ' selected' : '';
      return '<div class="run-row' + sel + '" data-id="' + escAttr(r.id) + '">' +
        '<div class="run-icon ' + iconClass + '">' + iconChar + '</div>' +
        '<div class="run-name">' + esc(r.name) + ' <span class="badge type">' + esc(r.type) + '</span></div>' +
        '<div class="run-rate" style="color:var(--' + rc + ')">' + (r.passRate * 100).toFixed(1) + '%</div>' +
        '<div class="run-counts">' + r.passed + '/' + r.total + '</div>' +
        '<div class="run-model">' + esc(r.model) + '</div>' +
        '<div class="run-date">' + dateStr + '</div>' +
      '</div>';
    }).join('');

    el.querySelectorAll('.run-row').forEach(row => {
      row.addEventListener('click', () => {
        selectedRunId = row.dataset.id;
        renderList();
        renderDetail();
      });
    });
  }

  async function renderDetail() {
    const panel = document.getElementById('detail-panel');
    if (!selectedRunId) { panel.innerHTML = ''; return; }

    const res = await fetch('/api/runs/' + selectedRunId);
    const run = await res.json();
    if (!run || !run.id) { panel.innerHTML = ''; return; }

    const rc = rateColor(run.passRate);
    const badgeClass = rc === 'green' ? 'pass' : rc === 'red' ? 'fail' : 'warn';
    const d = new Date(run.timestamp);

    let html = '<div class="detail-panel">' +
      '<div class="detail-header">' +
        '<div><div class="detail-title">' + esc(run.name) + '</div>' +
        '<div class="detail-meta" style="margin-top:6px">' +
          '<span>' + esc(run.model) + '</span>' +
          '<span>' + esc(run.provider) + '</span>' +
          '<span>' + d.toLocaleString() + '</span>' +
          '<span style="font-family:var(--mono);font-size:11px;color:var(--text-dim)">' + esc(run.id) + '</span>' +
        '</div></div>' +
        '<span class="badge ' + badgeClass + '">' + (run.passRate * 100).toFixed(1) + '% pass</span>' +
      '</div>';

    /* Score breakdown */
    html += '<div class="score-grid">';
    html += scoreItem('Pass Rate', (run.passRate * 100).toFixed(1) + '%', run.passRate, rc);
    html += scoreItem('Score', run.score.toFixed(2) + ' / ' + run.maxScore, run.maxScore > 0 ? run.score / run.maxScore : 0, 'accent');
    html += scoreItem('Passed', String(run.passed), run.total > 0 ? run.passed / run.total : 0, 'green');
    html += scoreItem('Failed', String(run.failed), run.total > 0 ? run.failed / run.total : 0, 'red');
    html += scoreItem('Total Cases', String(run.total), 1, 'accent');
    html += scoreItem('Latency', run.latencyMs + 'ms', Math.min(1, run.latencyMs / 10000), 'yellow');
    html += '</div>';

    /* Case results table */
    if (run.results && run.results.length > 0) {
      const keys = Object.keys(run.results[0]);
      html += '<div style="overflow-x:auto;max-height:600px;overflow-y:auto">';
      html += '<table class="case-table"><thead><tr>';
      html += keys.map(k => '<th>' + esc(k) + '</th>').join('');
      html += '</tr></thead><tbody>';
      html += run.results.map(r => {
        return '<tr>' + keys.map(k => {
          let v = r[k];
          let cls = '';
          if (k === 'passed' || k === 'pass') cls = v ? ' class="case-pass"' : ' class="case-fail"';
          if (k === 'score') cls = ' class="case-score"';
          if (typeof v === 'object' && v !== null) v = JSON.stringify(v, null, 2);
          if (typeof v === 'boolean') v = v ? 'PASS' : 'FAIL';
          const isLong = typeof v === 'string' && v.length > 60;
          return '<td' + cls + '>' + (isLong ? '<div class="case-text">' + esc(String(v)) + '</div>' : esc(String(v ?? ''))) + '</td>';
        }).join('') + '</tr>';
      }).join('');
      html += '</tbody></table></div>';
    } else {
      html += '<div style="padding:40px;text-align:center;color:var(--text-dim)">No individual case results stored for this run.<br><span style="font-size:12px">Tip: Re-run with <code style="background:rgba(139,92,246,0.15);color:var(--accent);padding:2px 6px;border-radius:4px">--output json</code> to capture case details.</span></div>';
    }

    html += '</div>';
    panel.innerHTML = html;
  }

  function scoreItem(label, value, ratio, color) {
    return '<div class="score-item">' +
      '<div class="score-item-label">' + label + '</div>' +
      '<div class="score-item-value" style="color:var(--' + color + ')">' + value + '</div>' +
      '<div class="progress-bar"><div class="progress-fill" style="width:' + (ratio * 100) + '%;background:var(--' + color + ')"></div></div>' +
    '</div>';
  }

  /* XSS (audit 2026-07-25 MEDIUM): every value that reaches innerHTML must be
     escaped. esc() is for TEXT positions; it leaves quotes intact, so it is
     NOT safe inside an attribute value. escAttr() additionally escapes both
     quote characters, which is what the run id needs - the id comes from an
     evalguard-results.json file in the current working directory, i.e. from
     whatever repo the developer just cloned, and a value ending in a double
     quote used to break out of data-id="..." and add an event-handler
     attribute that runs attacker JS with access to this page. */
  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function escAttr(s) {
    return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function render() {
    renderStats();
    renderList();
    if (selectedRunId) renderDetail();
  }

  /* Tab switching */
  document.getElementById('tabs').addEventListener('click', e => {
    if (!e.target.classList.contains('tab')) return;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    e.target.classList.add('active');
    currentTab = e.target.dataset.tab;
    selectedRunId = null;
    document.getElementById('detail-panel').innerHTML = '';
    render();
  });

  fetchRuns();
</script>
</body>
</html>`;
}

// ─── Local file discovery ───────────────────────────────────────────────────

function discoverLocalResults(): StoredRun[] {
  const localFiles = [
    "evalguard-results.json",
    "evalguard-output.json",
  ];

  const found: StoredRun[] = [];
  const cwd = process.cwd();

  for (const file of localFiles) {
    const fp = path.join(cwd, file);
    if (!fs.existsSync(fp)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(fp, "utf-8"));
      // Handle array of results or single result
      const items = Array.isArray(raw) ? raw : [raw];
      for (const item of items) {
        if (item.id && item.name) {
          found.push(item as StoredRun);
        }
      }
    } catch {
      // skip malformed files
    }
  }

  return found;
}

function getAllRuns(): StoredRun[] {
  const stored = listRuns(undefined, 1000);
  const local = discoverLocalResults();

  // Merge, dedup by ID (stored takes precedence)
  const seen = new Set(stored.map((r) => r.id));
  const merged = [...stored];
  for (const r of local) {
    if (!seen.has(r.id)) {
      merged.push(r);
      seen.add(r.id);
    }
  }

  // Sort newest first
  return merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

// ─── HTTP Server ────────────────────────────────────────────────────────────

function startServer(port: number): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // API: list all runs
    if (url.pathname === "/api/runs" && req.method === "GET") {
      const runs = getAllRuns();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(runs));
      return;
    }

    // API: get single run
    const runMatch = url.pathname.match(/^\/api\/runs\/(.+)$/);
    if (runMatch && req.method === "GET") {
      const id = decodeURIComponent(runMatch[1]);
      // Check stored runs first, then local
      let run = getRun(id);
      if (!run) {
        const local = discoverLocalResults();
        run = local.find((r) => r.id === id);
      }
      if (run) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(run));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Run not found" }));
      }
      return;
    }

    // Serve the SPA for everything else
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(buildHTML());
  });

  return server;
}

// ─── Browser opener ─────────────────────────────────────────────────────────

function openBrowser(url: string): void {
  // `exec` is imported statically at the top of this module. It used to be
  // pulled in with a bare `require("child_process")` — but apps/cli is
  // "type": "module" built by plain tsc, so `require` does not exist here and
  // this line threw `ReferenceError: require is not defined` every time,
  // making `evalguard view` unable to open a browser. Same defect class as
  // audit F109 in @evalguard/otel-sdk.
  const platform = process.platform;

  let cmd: string;
  if (platform === "darwin") {
    cmd = `open "${url}"`;
  } else if (platform === "win32") {
    cmd = `start "" "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }

  exec(cmd, (err: Error | null) => {
    if (err) {
      // Silently ignore — user can open manually
    }
  });
}

// ─── Command Registration ───────────────────────────────────────────────────

export function registerView(program: Command): void {
  program
    .command("view")
    .description("Open local web UI to browse eval/scan results")
    .option("-p, --port <port>", "Port number for the local server", "1337")
    .option("--no-open", "Don't auto-open the browser")
    .option("--host <host>", "Host to bind to", "localhost")
    .action((opts: { port: string; open: boolean; host: string }) => {
      const port = parseInt(opts.port, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error(chalk.red(`Invalid port: ${opts.port}`));
        process.exit(1);
      }

      const runs = getAllRuns();

      console.log();
      console.log(
        chalk.bold(`  EvalGuard Viewer`)
      );
      console.log(chalk.dim(`  ${"─".repeat(40)}`));
      console.log(`  ${chalk.dim("Runs found:")}  ${chalk.cyan(String(runs.length))}`);
      console.log(
        `  ${chalk.dim("Data from:")}   ${chalk.dim("~/.evalguard/results.json")}${
          discoverLocalResults().length > 0
            ? chalk.dim(" + local files")
            : ""
        }`
      );
      console.log();

      const server = startServer(port);

      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          console.error(
            chalk.red(`  Port ${port} is already in use.`) +
              chalk.dim(` Try: evalguard view --port ${port + 1}`)
          );
          process.exit(1);
        }
        console.error(chalk.red(`  Server error: ${err.message}`));
        process.exit(1);
      });

      server.listen(port, opts.host, () => {
        const url = `http://${opts.host}:${port}`;
        console.log(
          `  ${chalk.green(">")} Server running at ${chalk.cyan.underline(url)}`
        );
        console.log(chalk.dim(`  Press Ctrl+C to stop\n`));

        if (opts.open) {
          openBrowser(url);
        }
      });

      // Graceful shutdown
      const shutdown = () => {
        console.log(chalk.dim("\n  Shutting down..."));
        server.close(() => process.exit(0));
        // Force exit after 2s if connections hang
        setTimeout(() => process.exit(0), 2000);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
}
