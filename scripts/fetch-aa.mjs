#!/usr/bin/env node
/**
 * Pull the LLM leaderboard from the Artificial Analysis Data API (free tier)
 * and write a trimmed, stable snapshot to data/models.json. If the model data
 * is unchanged from the previous snapshot nothing is written, so the cron only
 * produces a commit when something actually moved.
 *
 * The free endpoint is paginated (200 per page) and already carries cost per
 * Intelligence Index task, so a single pass gives us everything. It does not
 * expose AA's blended price (Pro only); that is the plain 3:1 input:output
 * blend, so it is computed here from the per-token prices, which matched AA's
 * published figure to 3 dp across the whole legacy snapshot.
 *
 * Also maintains data/changelog.json: per-run diff of models added, removed,
 * or re-scored / re-priced.
 *
 * Docs: https://artificialanalysis.ai/data-api/docs  (spec: /api/v2/openapi)
 * Free tier is 100 requests per 24h; a run uses one request per page.
 * Attribution required by AA terms: https://artificialanalysis.ai/
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const MODELS_PATH = path.join(DATA_DIR, "models.json");
const CHANGELOG_PATH = path.join(DATA_DIR, "changelog.json");
const ENDPOINT = "https://artificialanalysis.ai/api/v2/language/models/free";
const MAX_PAGES = 50;
const CHANGELOG_MAX = 90;

const apiKey = process.env.AA_API_KEY;
if (!apiKey) {
  console.error("AA_API_KEY is not set. Get a free key at https://artificialanalysis.ai/ and export it (or add it as a GitHub Actions secret).");
  process.exit(1);
}

const positive = (v) => (v != null && v > 0 ? v : null); // AA reports 0 when a speed benchmark has not run
const round = (v, dp = 2) => (v == null || Number.isNaN(+v) ? null : Math.round(+v * 10 ** dp) / 10 ** dp);

const headers = { "x-api-key": apiKey, accept: "application/json" };

/** Walk every page of the free endpoint. Returns the raw model objects plus the index version. */
async function fetchAllModels() {
  const data = [];
  let indexVersion = null;
  for (let page = 1, more = true; more; page++) {
    const res = await fetch(`${ENDPOINT}?page=${page}`, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`AA API ${res.status} ${res.statusText} on page ${page}: ${body.slice(0, 300)}`);
    }
    const json = await res.json();
    if (!Array.isArray(json.data)) throw new Error("Unexpected response shape: no data[]");
    data.push(...json.data);
    indexVersion ??= json.intelligence_index_version ?? null;
    more = json.pagination?.has_more === true && page < MAX_PAGES;
  }
  return { data, indexVersion };
}

function normalise(raw) {
  const ev = raw.evaluations ?? {};
  const pr = raw.pricing ?? {};
  const perf = raw.performance ?? {};
  const input = round(pr.price_1m_input_tokens, 3);
  const output = round(pr.price_1m_output_tokens, 3);
  // AA's 3:1 input:output blend (Pro-only field), computed from the unrounded prices so ties round the same way AA's did.
  const blended = input != null && output != null ? round((3 * pr.price_1m_input_tokens + pr.price_1m_output_tokens) / 4, 3) : null;
  return {
    id: raw.id,
    name: raw.name,
    slug: raw.slug,
    creator: raw.model_creator?.name ?? "Unknown",
    index: round(ev.artificial_analysis_intelligence_index, 1),
    blended,
    input,
    output,
    task: round(positive(raw.artificial_analysis_intelligence_index_cost?.cost_per_task?.total_cost), 4),
    tps: positive(round(perf.median_output_tokens_per_second, 0)),
    ttft: positive(round(perf.median_time_to_first_token_seconds, 2)),
    url: raw.slug ? `https://artificialanalysis.ai/models/${raw.slug}` : null,
  };
}

async function readJson(p, fallback) {
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return fallback; }
}

function diff(prevModels, nextModels) {
  const byId = (arr) => new Map(arr.map((m) => [m.id, m]));
  const prev = byId(prevModels), next = byId(nextModels);
  const added = [], removed = [], changed = [];
  for (const [id, m] of next) {
    const p = prev.get(id);
    if (!p) { added.push({ name: m.name, creator: m.creator, index: m.index, blended: m.blended }); continue; }
    const fields = [];
    if (p.index !== m.index) fields.push({ field: "index", from: p.index, to: m.index });
    if (p.blended !== m.blended) fields.push({ field: "blended", from: p.blended, to: m.blended });
    if (p.input !== m.input) fields.push({ field: "input", from: p.input, to: m.input });
    if (p.output !== m.output) fields.push({ field: "output", from: p.output, to: m.output });
    if (p.task != null && m.task != null && p.task !== m.task) fields.push({ field: "cost/task", from: p.task, to: m.task });
    if (fields.length) changed.push({ name: m.name, creator: m.creator, fields });
  }
  for (const [id, p] of prev) if (!next.has(id)) removed.push({ name: p.name, creator: p.creator, index: p.index, blended: p.blended });
  return { added, removed, changed };
}

const stableKey = (models) => JSON.stringify(models.map((m) => {
  const { url, ...rest } = m; // url derives from slug
  return rest;
}));

async function main() {
  const { data, indexVersion } = await fetchAllModels();

  const models = data
    .map(normalise)
    .filter((m) => m.index != null && m.blended != null && m.blended > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (models.length < 10) throw new Error(`Only ${models.length} usable models returned; refusing to overwrite snapshot.`);

  const prev = await readJson(MODELS_PATH, null);
  const prevModels = prev?.models ?? [];
  const isSeed = prev?.source === "seed";

  if (prev && !isSeed && stableKey(prevModels) === stableKey(models)) {
    console.log(`No change: ${models.length} models identical to snapshot from ${prev.fetched_at}.`);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const snapshot = {
    fetched_at: new Date().toISOString(),
    source: "artificialanalysis.ai",
    endpoint: ENDPOINT,
    intelligence_index_version: indexVersion,
    attribution: "Data from Artificial Analysis (https://artificialanalysis.ai/). Attribution required.",
    count: models.length,
    models,
  };

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(MODELS_PATH, JSON.stringify(snapshot, null, 2) + "\n");

  if (prev && !isSeed) {
    const d = diff(prevModels, models);
    if (d.added.length || d.removed.length || d.changed.length) {
      const log = await readJson(CHANGELOG_PATH, []);
      log.unshift({ date: today, ...d });
      await writeFile(CHANGELOG_PATH, JSON.stringify(log.slice(0, CHANGELOG_MAX), null, 2) + "\n");
    }
    console.log(`Updated: ${models.length} models. +${d.added.length} / -${d.removed.length} / ~${d.changed.length} changed.`);
  } else {
    if (!existsSync(CHANGELOG_PATH)) await writeFile(CHANGELOG_PATH, "[]\n");
    console.log(`Wrote first real snapshot: ${models.length} models.`);
  }
}

main().catch((err) => { console.error(err.message ?? err); process.exit(1); });
