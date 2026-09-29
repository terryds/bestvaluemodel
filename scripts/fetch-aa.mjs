#!/usr/bin/env node
/**
 * Pull the LLM leaderboard from the Artificial Analysis free API and write
 * a trimmed, stable snapshot to data/models.json. If the model data is
 * unchanged from the previous snapshot nothing is written, so a daily cron
 * only produces a commit when something actually moved.
 *
 * Cost per Intelligence Index task comes from a second, paginated endpoint
 * and is merged in by model id.
 *
 * Also maintains data/changelog.json: per-run diff of models added, removed,
 * or re-scored / re-priced.
 *
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
const ENDPOINT = "https://artificialanalysis.ai/api/v2/data/llms/models";
const COST_ENDPOINT = "https://artificialanalysis.ai/api/v2/language/models/free"; // paginated; carries cost per Intelligence Index task
const CHANGELOG_MAX = 90;

const apiKey = process.env.AA_API_KEY;
if (!apiKey) {
  console.error("AA_API_KEY is not set. Get a free key at https://artificialanalysis.ai/ and export it (or add it as a GitHub Actions secret).");
  process.exit(1);
}

const positive = (v) => (v != null && v > 0 ? v : null); // AA reports 0 when a speed benchmark has not run
const round = (v, dp = 2) => (v == null || Number.isNaN(+v) ? null : Math.round(+v * 10 ** dp) / 10 ** dp);

const headers = { "x-api-key": apiKey, accept: "application/json" };

/** Map of model id -> weighted average USD cost to complete one Intelligence Index task. */
async function fetchTaskCosts() {
  const costs = new Map();
  for (let page = 1, more = true; more; page++) {
    const res = await fetch(`${COST_ENDPOINT}?page=${page}`, { headers });
    if (!res.ok) throw new Error(`AA API ${res.status} ${res.statusText} on ${COST_ENDPOINT} page ${page}`);
    const json = await res.json();
    if (!Array.isArray(json.data)) throw new Error("Unexpected response shape: no data[]");
    for (const m of json.data) {
      const c = positive(m.artificial_analysis_intelligence_index_cost?.cost_per_task?.total_cost);
      if (c != null) costs.set(m.id, round(c, 4));
    }
    more = json.pagination?.has_more === true && page < 50;
  }
  return costs;
}

function normalise(raw) {
  const ev = raw.evaluations ?? {};
  const pr = raw.pricing ?? {};
  return {
    id: raw.id,
    name: raw.name,
    slug: raw.slug,
    creator: raw.model_creator?.name ?? "Unknown",
    creator_slug: raw.model_creator?.slug ?? null,
    index: round(ev.artificial_analysis_intelligence_index, 1),
    coding: round(ev.artificial_analysis_coding_index, 1),
    math: round(ev.artificial_analysis_math_index, 1),
    blended: round(pr.price_1m_blended_3_to_1, 3),
    input: round(pr.price_1m_input_tokens, 3),
    output: round(pr.price_1m_output_tokens, 3),
    task: null, // filled in from COST_ENDPOINT
    tps: positive(round(raw.median_output_tokens_per_second, 0)),
    ttft: positive(round(raw.median_time_to_first_token_seconds, 2)),
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
  const res = await fetch(ENDPOINT, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`AA API ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  if (!Array.isArray(json.data)) throw new Error("Unexpected response shape: no data[]");

  const models = json.data
    .map(normalise)
    .filter((m) => m.index != null && m.blended != null && m.blended > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (models.length < 10) throw new Error(`Only ${models.length} usable models returned; refusing to overwrite snapshot.`);

  const prev = await readJson(MODELS_PATH, null);
  const prevModels = prev?.models ?? [];
  const isSeed = prev?.source === "seed";

  // Cost per task is an extra; if that endpoint fails, keep the last known values rather than losing the run.
  let costs;
  try { costs = await fetchTaskCosts(); }
  catch (err) {
    console.warn(`Cost per task not refreshed (${err.message ?? err}); carrying over previous values.`);
    costs = new Map(prevModels.filter((m) => m.task != null).map((m) => [m.id, m.task]));
  }
  models.forEach((m) => { m.task = costs.get(m.id) ?? null; });

  if (prev && !isSeed && stableKey(prevModels) === stableKey(models)) {
    console.log(`No change: ${models.length} models identical to snapshot from ${prev.fetched_at}.`);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const snapshot = {
    fetched_at: new Date().toISOString(),
    source: "artificialanalysis.ai",
    endpoint: ENDPOINT,
    cost_endpoint: COST_ENDPOINT,
    prompt_options: json.prompt_options ?? null,
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
