#!/usr/bin/env node
/**
 * Builds the static Anubians archive.
 *
 * Sources:
 *  - explorer-service.hathor.network  /tokens?search_text=Anubian  -> every Anubian token UID
 *  - explorer.nileswap.com/token_detail/<uid>                      -> attributes + token string
 *  - explorer-service.hathor.network /metadata/dag?id=<uid>        -> NFT media (image) URL
 *
 * Why the token list instead of the A<n> shorthand search: the nileswap search endpoint
 * hangs (HTTP 504) for every number that was minted twice, so the shorthand cannot be used
 * as the primary key. The token list always answers.
 *
 * Output:
 *  - wwwroot/archive/img/<n>.png
 *  - wwwroot/archive/data.json
 *
 * Progress is cached in tools/.cache/records.jsonl so a run can be resumed.
 *
 * Usage:
 *   node tools/scrape-anubians.mjs                     # scrape what is missing, rebuild data.json
 *   node tools/scrape-anubians.mjs --from 1 --to 200
 *   node tools/scrape-anubians.mjs --concurrency 8
 *   node tools/scrape-anubians.mjs --build-only        # only rebuild data.json from the cache
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const OUT_DIR = path.join(ROOT, 'wwwroot', 'archive');
const IMG_DIR = path.join(OUT_DIR, 'img');
const CACHE_DIR = path.join(here, '.cache');
const STATE_FILE = path.join(CACHE_DIR, 'records.jsonl');
const MAP_FILE = path.join(CACHE_DIR, 'uid-map.json');
const CHOICE_FILE = path.join(CACHE_DIR, 'uid-choice.json');

const NILESWAP = 'https://explorer.nileswap.com';
const EXPLORER_SERVICE = 'https://explorer-service.hathor.network';
const EXPLORER_ORIGIN = 'https://explorer.hathor.network';
const HATHOR_NODE = 'https://node1.mainnet.hathor.network';

// A handful of tokens were minted without nft_media, but their artwork is still pinned:
// fall back to the IPFS path published on the token page, trying several gateways.
const IPFS_GATEWAYS = [
  'https://hathor-nft-review-mainnet.s3.eu-central-1.amazonaws.com/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://ipfs.filebase.io/ipfs/',
  'https://ipfs.io/ipfs/',
];

const TOTAL = 10000;

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback;
}
const FROM = Number(arg('from', 1));
const TO = Number(arg('to', TOTAL));
const BUILD_ONLY = argv.includes('--build-only');
const CONCURRENCY = Number(arg('concurrency', 8));

function log(...args) {
  process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${args.join(' ')}\n`);
}

async function request(url, options = {}, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt + Math.random() * 300));
      }
    }
  }
  throw lastError;
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/* ---------- Token index ---------- */

let uidMapPromise = null;
async function getUidMap() {
  if (!uidMapPromise) uidMapPromise = buildUidMap();
  return uidMapPromise;
}

async function buildUidMap() {
  if (fs.existsSync(MAP_FILE)) {
    try {
      const map = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
      if (map && Object.keys(map).length > 9000) return map;
    } catch {
      /* rebuild below */
    }
  }
  log('building the token index from explorer-service');
  const map = {};
  let searchAfter = '';
  for (let page = 0; page < 3000; page++) {
    const params = new URLSearchParams({ search_text: 'Anubian', sort_by: 'id', order: 'asc' });
    if (searchAfter) params.set('search_after', searchAfter);
    const res = await request(`${EXPLORER_SERVICE}/tokens?${params}`, {
      headers: { Origin: EXPLORER_ORIGIN },
    });
    const json = await res.json();
    const hits = json.hits || [];
    for (const hit of hits) {
      const match = /^Anubian #(\d+)$/.exec(hit.name || '');
      if (!match) continue;
      const n = Number(match[1]);
      if (!map[n]) map[n] = [];
      if (!map[n].includes(hit.id)) map[n].push(hit.id);
    }
    if (!json.has_next || !hits.length) break;
    const last = hits[hits.length - 1].sort;
    searchAfter = `${last[0]},${last[1]}`;
    if (page % 100 === 0) log(`  index page ${page}`);
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(MAP_FILE, JSON.stringify(map));
  log(`token index built: ${Object.keys(map).length} numbers`);
  return map;
}

/* ---------- Metadata ---------- */

async function metadataFor(uid) {
  const res = await request(`${EXPLORER_SERVICE}/metadata/dag?id=${encodeURIComponent(uid)}`, {
    headers: { Origin: EXPLORER_ORIGIN },
  });
  const json = await res.json();
  return json?.[uid] || json?.[Object.keys(json)[0]] || {};
}

async function transactionCount(uid) {
  try {
    const res = await request(`${HATHOR_NODE}/v1a/thin_wallet/token?id=${encodeURIComponent(uid)}`);
    const json = await res.json();
    return Number(json.transactions_count) || 0;
  } catch {
    return 0;
  }
}

/**
 * Some numbers were minted twice, so a number can map to two tokens. Both variants carry the
 * same image file, only the trait metadata differs: prefer the token that still has NFT media
 * on chain, then the one that actually circulated.
 */
async function chooseUid(n, candidates, choices, mediaCache) {
  if (candidates.length === 1) return candidates[0];
  if (choices[n] && candidates.includes(choices[n])) return choices[n];

  const withMedia = [];
  for (const uid of candidates) {
    const meta = await metadataFor(uid);
    mediaCache.set(uid, meta);
    if (meta?.nft_media?.file) withMedia.push(uid);
  }

  let chosen;
  if (withMedia.length === 1) {
    chosen = withMedia[0];
  } else {
    const pool = withMedia.length ? withMedia : candidates;
    const counts = await Promise.all(pool.map((uid) => transactionCount(uid)));
    let best = 0;
    pool.forEach((uid, index) => {
      const better = counts[index] > counts[best] || (counts[index] === counts[best] && uid < pool[best]);
      if (better) best = index;
    });
    chosen = pool[best];
  }
  choices[n] = chosen;
  return chosen;
}

/* ---------- Scraping ---------- */

function parseTokenPage(html, uid) {
  const name = decodeEntities((/<h1>([^<]*)<\/h1>/.exec(html) || [])[1] || '');
  const tokenString = decodeEntities((/data-clipboard-text="([^"]*)"/.exec(html) || [])[1] || '');
  const ipfs = (/(?:data-src|src)="[^"]*?\/ipfs\/([^"]+)"/.exec(html) || [])[1] || '';
  const attributes = [];
  const attrRe = /<li><p>([^<]+)<\/p><p>([^<]+)<\/p><span>([^<]+)<\/span><\/li>/g;
  let match;
  while ((match = attrRe.exec(html))) {
    attributes.push({
      type: decodeEntities(match[1]).trim(),
      value: decodeEntities(match[2]).trim(),
      rarity: parseFloat(match[3]),
    });
  }
  if (!name) throw new Error('token name not found');
  return { uid, name, tokenString, attributes, ipfs };
}

async function downloadImage(url, target) {
  const res = await request(url);
  if (!res.ok) throw new Error(`image HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 500) throw new Error(`image too small (${buffer.length} bytes)`);
  fs.writeFileSync(target, buffer);
  return buffer.length;
}

async function scrapeOne(n, context) {
  const { uidMap, choices, mediaCache } = context;
  const candidates = uidMap[n];
  if (!candidates || !candidates.length) throw new Error('not in the token index');

  const uid = await chooseUid(n, candidates, choices, mediaCache);

  const res = await request(`${NILESWAP}/token_detail/${uid}`);
  if (!res.ok) throw new Error(`token detail HTTP ${res.status}`);
  const parsed = parseTokenPage(await res.text(), uid);

  const record = {
    n,
    name: parsed.name,
    symbol: '',
    uid,
    tokenString: parsed.tokenString,
    attributes: parsed.attributes,
    scrapedAt: new Date().toISOString(),
  };

  const parts = /^\[(.*):([^:]+):([0-9a-f]{64}):([0-9a-f]+)\]$/i.exec(parsed.tokenString);
  if (parts) {
    record.name = parts[1];
    record.symbol = parts[2];
    record.uid = parts[3].toLowerCase();
    record.version = parts[4];
  }
  if (!record.attributes.length) throw new Error('no attributes on the token page');

  let media = mediaCache.get(record.uid);
  if (!media) {
    media = await metadataFor(record.uid);
    mediaCache.set(record.uid, media);
  }
  const imageTarget = path.join(IMG_DIR, `${n}.png`);
  const sources = [];
  if (media?.nft_media?.file) sources.push(media.nft_media.file);
  if (parsed.ipfs) for (const gateway of IPFS_GATEWAYS) sources.push(gateway + parsed.ipfs);
  if (sources.length) record.imageUrl = sources[0];
  if (!fs.existsSync(imageTarget)) {
    for (const url of sources) {
      try {
        record.imageUrl = url;
        record.imageBytes = await downloadImage(url, imageTarget);
        break;
      } catch {
        /* try the next source */
      }
    }
    if (!fs.existsSync(imageTarget)) {
      log(`#${n} WARNING: no image (tried ${sources.length} sources)`);
    }
  }
  return record;
}

function readState() {
  const map = new Map();
  if (!fs.existsSync(STATE_FILE)) return map;
  for (const line of fs.readFileSync(STATE_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && record.n) map.set(record.n, record);
    } catch {
      /* ignore a partially written line */
    }
  }
  return map;
}

function appendState(record) {
  fs.appendFileSync(STATE_FILE, `${JSON.stringify(record)}\n`);
}

function readChoices() {
  if (!fs.existsSync(CHOICE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CHOICE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveChoices(choices) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CHOICE_FILE, JSON.stringify(choices));
}

async function scrape() {
  fs.mkdirSync(IMG_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const uidMap = await getUidMap();
  const choices = readChoices();
  const state = readState();
  const context = { uidMap, choices, mediaCache: new Map() };

  const pending = [];
  for (let n = FROM; n <= TO; n++) {
    const cached = state.get(n);
    if (cached && fs.existsSync(path.join(IMG_DIR, `${n}.png`))) continue;
    if (cached && cached.imageUrl) {
      try {
        await downloadImage(cached.imageUrl, path.join(IMG_DIR, `${n}.png`));
        continue;
      } catch {
        /* scrape the record again below */
      }
    }
    pending.push(n);
  }
  log(`scraping ${pending.length} items (concurrency ${CONCURRENCY})`);

  let done = 0;
  let failed = 0;
  const failures = [];
  let cursor = 0;

  async function worker() {
    while (cursor < pending.length) {
      const n = pending[cursor++];
      try {
        const record = await scrapeOne(n, context);
        appendState(record);
        state.set(n, record);
      } catch (error) {
        failed++;
        failures.push({ n, error: error.message });
        log(`#${n} FAILED: ${error.message}`);
      }
      done++;
      if (done % 100 === 0) log(`progress ${done}/${pending.length} (failed ${failed})`);
      if (done % 500 === 0) saveChoices(choices);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  saveChoices(choices);
  if (failures.length) {
    log(`failures: ${failures.length}`);
    fs.writeFileSync(path.join(CACHE_DIR, 'failures.json'), JSON.stringify(failures, null, 2));
  }
  return state;
}

function buildData(state) {
  const items = [];
  const missing = [];
  const withoutImage = [];
  for (let n = 1; n <= TOTAL; n++) {
    const record = state.get(n);
    if (!record) {
      missing.push(n);
      continue;
    }
    const hasImage = fs.existsSync(path.join(IMG_DIR, `${n}.png`));
    if (!hasImage) withoutImage.push(n);
    items.push({
      n: record.n,
      name: record.name,
      symbol: record.symbol,
      uid: record.uid,
      token: record.tokenString,
      a: record.attributes.map((a) => [a.type, a.value, a.rarity]),
      ...(hasImage ? {} : { noimg: true }),
    });
  }
  if (missing.length) log(`WARNING: ${missing.length} Anubians missing: ${missing.slice(0, 20).join(', ')}`);
  if (withoutImage.length) log(`WARNING: ${withoutImage.length} Anubians without an image`);
  const data = { generated: new Date().toISOString(), total: items.length, items };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'data.json'), JSON.stringify(data));
  log(`wrote data.json with ${items.length} items`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let state = readState();
  if (!BUILD_ONLY) state = await scrape();
  buildData(state);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
