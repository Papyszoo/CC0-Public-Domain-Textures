#!/usr/bin/env node
// Downloads, converts to max 512px KTX2, and generates manifests for TextureCan CC0 PBR textures.
// All TextureCan materials are consolidated into packs/texturecan-textures/ ("one source - one pack").
//
// Usage:
//   node scripts/fetch-texturecan-textures.mjs --concurrency 6 --all

import { execSync, fork } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, unlinkSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(__filename), '..');
const PACK_SLUG = 'texturecan-textures';
const PACK_DIR = path.join(REPO, 'packs', PACK_SLUG);
const TEXTURES_DIR = path.join(PACK_DIR, 'textures');
const INDEX_FILE = path.join(PACK_DIR, 'index.json');
const SCRIPTS_DIR = path.join(REPO, 'scripts');

mkdirSync(TEXTURES_DIR, { recursive: true });

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : (args.includes('--all') ? Infinity : 20);
const idsIdx = args.indexOf('--ids');
const targetIds = idsIdx !== -1 ? args[idsIdx + 1].split(',').map((s) => s.trim().toLowerCase()) : null;
const catIdx = args.indexOf('--category');
const targetCat = catIdx !== -1 ? args[catIdx + 1].toLowerCase() : null;
const concIdx = args.indexOf('--concurrency');
const CONCURRENCY = concIdx !== -1 ? parseInt(args[concIdx + 1], 10) : 6;

const workerArgIdx = args.indexOf('--worker-slice');
const isWorker = workerArgIdx !== -1;

const CATEGORIES = [
  'Bricks', 'Concrete', 'Fabrics', 'Food', 'Ground',
  'Marble', 'Metal', 'Paper', 'Plants', 'Plastic',
  'Rock', 'Tiles', 'Wood', 'Others'
];

function toPascalCase(str) {
  return str
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

function getItemSlug(item) {
  const m = item.title.match(/\(([^)]+)\)$/);
  if (m) {
    return toPascalCase(m[1]);
  }
  return toPascalCase(item.title);
}

async function fetchIndex() {
  if (existsSync(INDEX_FILE)) {
    try {
      const cached = JSON.parse(readFileSync(INDEX_FILE, 'utf8'));
      if (Array.isArray(cached) && cached.length > 500) {
        return cached;
      }
    } catch {}
  }

  console.log('Crawling TextureCan category pages to build index...');
  const items = new Map();

  for (const cat of CATEGORIES) {
    let page = 1;
    while (true) {
      const url = page === 1
        ? `https://www.texturecan.com/category/${cat}/`
        : `https://www.texturecan.com/category/${cat}/${page}/`;

      try {
        const res = await fetch(url);
        if (!res.ok) break;
        const html = await res.text();
        const matches = [...html.matchAll(/<div class="texture-header"><a href="\/details\/(\d+)\/">([\s\S]*?)<\/a><\/div>[\s\S]*?<img src="([^"]+)"/g)];
        if (matches.length === 0) break;

        for (const m of matches) {
          const id = m[1];
          const rawTitle = m[2].replace(/<br\s*\/?>/g, ' ').replace(/\s+/g, ' ').trim();
          const img = m[3];
          if (!items.has(id)) {
            items.set(id, { id, title: rawTitle, category: cat, thumbnail: img });
          }
        }

        if (!html.includes(`/category/${cat}/${page + 1}/`)) break;
        page++;
      } catch (err) {
        console.warn(`  Warning crawling ${url}:`, err.message);
        break;
      }
    }
  }

  const list = Array.from(items.values());
  writeFileSync(INDEX_FILE, JSON.stringify(list, null, 2));
  console.log(`Saved index with ${list.length} TextureCan materials to index.json`);
  return list;
}

function downloadFile(url, destPath) {
  if (existsSync(destPath)) return true;
  try {
    execSync(
      `curl -sL -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" -o "${destPath}" "${url}"`,
      { stdio: ['ignore', 'ignore', 'inherit'] }
    );
    if (!existsSync(destPath)) return false;
    const stat = readFileSync(destPath, { encoding: 'utf8', flag: 'r' });
    if (stat.includes('<Error>') || stat.includes('404 Not Found') || stat.includes('403 Forbidden')) {
      try { unlinkSync(destPath); } catch {}
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function processItem(item, index, total, workerId) {
  const itemSlug = getItemSlug(item);
  const matDir = path.join(TEXTURES_DIR, itemSlug);
  const previewPngPath = path.join(matDir, `${itemSlug}_preview.png`);

  if (existsSync(matDir) && existsSync(previewPngPath)) {
    const existingFiles = readdirSync(matDir);
    if (existingFiles.some((f) => f.endsWith('.ktx2'))) {
      return;
    }
  }

  console.log(`[${index + 1}/${total}] [W${workerId}] Processing: ${item.title} (${itemSlug})`);
  mkdirSync(matDir, { recursive: true });

  const tempDir = path.join(REPO, 'packs', `__temp_texcan_w${workerId}`);
  mkdirSync(tempDir, { recursive: true });

  let detailHtml = '';
  try {
    const res = await fetch(`https://www.texturecan.com/details/${item.id}/`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    detailHtml = await res.text();
  } catch (err) {
    console.warn(`  [W${workerId}] Failed to fetch detail page for ID ${item.id}:`, err.message);
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    return;
  }

  // Extract 1K zip URL
  const d1kMatch = detailHtml.match(/href="(\/downloads\/[^"]+_1k_[^"]+\.zip)"/i) ||
                   detailHtml.match(/href="(\/downloads\/[^"]+\.zip)"/i);
  if (!d1kMatch) {
    console.warn(`  [W${workerId}] No zip download found for ID ${item.id}`);
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    return;
  }

  const zipUrl = `https://www.texturecan.com${d1kMatch[1]}`;
  const zipDest = path.join(tempDir, `${itemSlug}.zip`);
  const ok = downloadFile(zipUrl, zipDest);
  if (!ok || !existsSync(zipDest)) {
    console.warn(`  [W${workerId}] Failed to download zip from ${zipUrl}`);
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    return;
  }

  try {
    execSync(`unzip -o -q "${zipDest}" -d "${matDir}"`, { stdio: 'inherit' });
  } catch (err) {
    console.error(`  [W${workerId}] Failed to extract ${zipDest}:`, err.message);
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    return;
  }

  // Clean up unwanted non-standard files (DirectX normal duplicates, SBSAR, MACOSX)
  try {
    const rawFiles = readdirSync(matDir, { recursive: true });
    for (const f of rawFiles) {
      const full = path.join(matDir, f);
      if (
        f.includes('__MACOSX') ||
        f.startsWith('._') ||
        f.endsWith('.sbsar') ||
        f.toLowerCase().includes('normal_directx') ||
        f.toLowerCase().includes('directx')
      ) {
        try { unlinkSync(full); } catch {}
      }
    }
  } catch {}

  // Sphere render preview image
  let previewCreated = false;
  const sphereMatch = detailHtml.match(/src="(\/img\/textures\/[^"]+_sphere_600\.png)"/i) ||
                      detailHtml.match(/src="(\/img\/textures\/[^"]+\.png)"/i);

  if (sphereMatch) {
    const sphereUrl = `https://www.texturecan.com${sphereMatch[1]}`;
    const rawPreview = path.join(tempDir, `${itemSlug}_sphere.png`);
    if (downloadFile(sphereUrl, rawPreview) && existsSync(rawPreview)) {
      try {
        execSync(`sips -Z 256 "${rawPreview}" --out "${previewPngPath}"`, {
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        previewCreated = true;
      } catch {}
    }
  }

  if (!previewCreated || !existsSync(previewPngPath)) {
    const localFiles = readdirSync(matDir);
    const baseColor = localFiles.find((f) => /base_?color|diff|alb|color/i.test(f) && !f.endsWith('.ktx2'));
    if (baseColor) {
      try {
        execSync(`sips -Z 256 "${path.join(matDir, baseColor)}" --out "${previewPngPath}"`, {
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        previewCreated = true;
      } catch {}
    }
  }

  try {
    execSync(
      `node "${path.join(SCRIPTS_DIR, 'convert-to-ktx2.mjs')}" --file "${matDir}" 2>/dev/null || node "${path.join(SCRIPTS_DIR, 'convert-to-ktx2.mjs')}" --pack "${PACK_SLUG}"`,
      { stdio: 'inherit' }
    );
  } catch (err) {
    console.error(`  [W${workerId}] Conversion error on ${itemSlug}:`, err.message);
  }

  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
}

async function runWorker(workerId, sliceStart, sliceEnd) {
  const items = await fetchIndex();
  let filtered = items;
  if (targetCat) {
    filtered = filtered.filter((i) => (i.category || '').toLowerCase() === targetCat);
  }
  if (targetIds) {
    const targetSet = new Set(targetIds);
    filtered = filtered.filter(
      (i) => targetSet.has(i.id) || targetSet.has(getItemSlug(i).toLowerCase())
    );
  } else if (limit < filtered.length) {
    filtered = filtered.slice(0, limit);
  }

  const myItems = filtered.slice(sliceStart, sliceEnd);
  console.log(`[W${workerId}] Started processing ${myItems.length} items (${sliceStart}..${sliceEnd})...`);

  for (let i = 0; i < myItems.length; i++) {
    await processItem(myItems[i], sliceStart + i, filtered.length, workerId);
  }
  console.log(`[W${workerId}] Completed slice!`);
}

async function runMaster() {
  const items = await fetchIndex();
  let filtered = items;
  if (targetCat) {
    filtered = filtered.filter((i) => (i.category || '').toLowerCase() === targetCat);
  }
  if (targetIds) {
    const targetSet = new Set(targetIds);
    filtered = filtered.filter(
      (i) => targetSet.has(i.id) || targetSet.has(getItemSlug(i).toLowerCase())
    );
  } else if (limit < filtered.length) {
    filtered = filtered.slice(0, limit);
  }

  console.log(`Spawning ${CONCURRENCY} parallel worker processes for ${filtered.length} TextureCan materials...`);

  const chunkSize = Math.ceil(filtered.length / CONCURRENCY);
  const childPromises = [];

  for (let w = 0; w < CONCURRENCY; w++) {
    const sliceStart = w * chunkSize;
    const sliceEnd = Math.min(sliceStart + chunkSize, filtered.length);
    if (sliceStart >= filtered.length) break;

    const workerId = w + 1;
    const workerArgs = [
      ...args.filter((a, idx, arr) => a !== '--worker-slice' && arr[idx - 1] !== '--worker-slice'),
      '--worker-slice',
      `${workerId}:${sliceStart}:${sliceEnd}`,
    ];

    const cp = fork(__filename, workerArgs, { stdio: 'inherit' });
    childPromises.push(
      new Promise((resolve, reject) => {
        cp.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Worker ${workerId} exited with code ${code}`));
        });
      })
    );
  }

  await Promise.all(childPromises);

  // Pack cover image
  const coverPath = path.join(PACK_DIR, 'cover.png');
  if (!existsSync(coverPath)) {
    try {
      const coverUrl = 'https://www.texturecan.com/img/textures/tiles_0128/tiles_0128_sphere_600.png';
      execSync(`curl -sL "${coverUrl}" -o "${coverPath}"`, { stdio: 'ignore' });
    } catch {}
  }

  console.log('\nAll workers completed! Generating store manifests...');
  execSync(`node "${path.join(SCRIPTS_DIR, 'generate-store-manifest.mjs')}" --root`, { stdio: 'inherit' });
}

async function main() {
  if (isWorker) {
    const sliceArg = args[workerArgIdx + 1];
    const [workerId, startStr, endStr] = sliceArg.split(':');
    await runWorker(parseInt(workerId, 10), parseInt(startStr, 10), parseInt(endStr, 10));
  } else {
    await runMaster();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
