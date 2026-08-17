#!/usr/bin/env node
// Downloads, converts to max 512px KTX2, and generates manifests for cgbookcase CC0 PBR textures.
// All cgbookcase materials are consolidated into packs/cgbookcase-textures/ ("one source - one pack").
//
// Usage:
//   node scripts/fetch-cgbookcase-textures.mjs --concurrency 6 --all

import { execSync, fork } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync, unlinkSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(__filename), '..');
const PACK_SLUG = 'cgbookcase-textures';
const PACK_DIR = path.join(REPO, 'packs', PACK_SLUG);
const TEXTURES_DIR = path.join(PACK_DIR, 'textures');
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

function toPascalCase(str) {
  return str
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

async function fetchJson(url) {
  const output = execSync(`curl -sL "${url}"`, { maxBuffer: 20 * 1024 * 1024 }).toString();
  return JSON.parse(output);
}

function downloadFileWithHeaders(url, destPath) {
  if (existsSync(destPath)) return true;
  try {
    execSync(
      `curl -sL -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" -H "Referer: https://www.cgbookcase.com/" -o "${destPath}" "${url}"`,
      { stdio: ['ignore', 'ignore', 'inherit'] }
    );
    const stats = readFileSync(destPath, { encoding: 'utf8', flag: 'r' });
    if (stats.includes('<Error>') || stats.includes('404 Not Found') || stats.includes('403 Forbidden')) {
      try { unlinkSync(destPath); } catch {}
      return false;
    }
    return true;
  } catch (err) {
    return false;
  }
}

function getDownloadCandidates(item) {
  const pascal = toPascalCase(item.title);
  const noSpace = item.title.replace(/\s+/g, '');
  const slugs = [...new Set([pascal, noSpace])];
  const isSingleImage = (item.categories || []).includes('Surface Imperfections') || (item.categories || []).includes('Cutout Objects');
  const isPattern = (item.categories || []).includes('Patterns');
  const isNew = item.id > 538;

  const urls = [];
  for (const slug of slugs) {
    if (isPattern) {
      urls.push({ url: `https://cgbookcase-volume.b-cdn.net/t/${slug}_1K.zip`, isZip: true });
      urls.push({ url: `https://cgbookcase-volume.b-cdn.net/t/${slug}_2K.zip`, isZip: true });
      urls.push({ url: `https://cgbookcase-volume.b-cdn.net/t/${slug}_4K.zip`, isZip: true });
    } else if (isSingleImage) {
      urls.push({ url: `https://cgbookcase-volume.b-cdn.net/t/${slug}/${slug}_1K.png`, isZip: false, ext: '.png' });
      urls.push({ url: `https://cgbookcase-volume.b-cdn.net/t/${slug}/${slug}_2K.png`, isZip: false, ext: '.png' });
      urls.push({ url: `https://cgbookcase-volume.b-cdn.net/t/${slug}/${slug}_4K.png`, isZip: false, ext: '.png' });
      urls.push({ url: `https://cgbookcase-volume.b-cdn.net/t/${slug}_1K.png`, isZip: false, ext: '.png' });
      urls.push({ url: `https://cgbookcase-volume.b-cdn.net/t/${slug}_MR_1K.zip`, isZip: true });
    } else {
      if (isNew) {
        urls.push({ url: `https://cgbookcase-volume.b-cdn.net/t/${slug}_1K.zip`, isZip: true });
        urls.push({ url: `https://cgbookcase-volume.b-cdn.net/t/${slug}_MR_1K.zip`, isZip: true });
        urls.push({ url: `https://cgbookcase-volume.b-cdn.net/t/${slug}_2K.zip`, isZip: true });
        urls.push({ url: `https://cgbookcase-volume.b-cdn.net/t/${slug}_4K.zip`, isZip: true });
      } else {
        urls.push({ url: `https://cgbookcase-volume.b-cdn.net/t/${slug}_MR_1K.zip`, isZip: true });
        urls.push({ url: `https://cgbookcase-volume.b-cdn.net/t/${slug}_MR_2K.zip`, isZip: true });
        urls.push({ url: `https://cgbookcase-volume.b-cdn.net/t/${slug}_1K.zip`, isZip: true });
        urls.push({ url: `https://cgbookcase-volume.b-cdn.net/t/${slug}_MR_4K.zip`, isZip: true });
      }
    }
  }
  return urls;
}

function getPreviewCandidates(item) {
  const pascal = toPascalCase(item.title);
  return [
    `https://cgbookcase.b-cdn.net/textures/renders/2024_b/${pascal}_render_default.jpg?width=480`,
    `https://cgbookcase.b-cdn.net/textures/thumbnails/${pascal}_1K/${pascal}_1K_BaseColor.png?width=360`,
    `https://cgbookcase.b-cdn.net/textures/thumbnails/${pascal}_1K/${pascal}_1K_Base_Color.png?width=360`,
    `https://cgbookcase.b-cdn.net/textures/thumbnails/${pascal}/${pascal}_1K.png?width=360`,
  ];
}

function processItem(item, index, total, workerId) {
  const itemSlug = toPascalCase(item.title);
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

  const tempDir = path.join(REPO, 'packs', `__temp_cgbookcase_w${workerId}`);
  mkdirSync(tempDir, { recursive: true });

  const candidates = getDownloadCandidates(item);
  let downloadedPath = null;
  let isZipArchive = true;

  for (const cand of candidates) {
    const ext = cand.isZip ? '.zip' : (cand.ext || '.png');
    const testDest = path.join(tempDir, `${itemSlug}${ext}`);
    try { if (existsSync(testDest)) unlinkSync(testDest); } catch {}
    const ok = downloadFileWithHeaders(cand.url, testDest);
    if (ok && existsSync(testDest)) {
      downloadedPath = testDest;
      isZipArchive = cand.isZip;
      break;
    }
  }

  if (!downloadedPath || !existsSync(downloadedPath)) {
    console.warn(`  [W${workerId}] Skipping ${item.title} (no working download found)`);
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    return;
  }

  if (isZipArchive) {
    try {
      execSync(`unzip -o -q "${downloadedPath}" -d "${matDir}"`, { stdio: 'inherit' });
    } catch (err) {
      console.error(`  [W${workerId}] Failed to extract ${downloadedPath}:`, err.message);
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
      return;
    }
  } else {
    const targetFileName = `${itemSlug}_BaseColor.png`;
    copyFileSync(downloadedPath, path.join(matDir, targetFileName));
  }

  let previewCreated = false;
  const previewCandidates = getPreviewCandidates(item);
  const tempPreviewJpg = path.join(tempDir, `${itemSlug}_raw_preview.jpg`);

  for (const pUrl of previewCandidates) {
    try { if (existsSync(tempPreviewJpg)) unlinkSync(tempPreviewJpg); } catch {}
    const ok = downloadFileWithHeaders(pUrl, tempPreviewJpg);
    if (ok && existsSync(tempPreviewJpg)) {
      try {
        execSync(`sips -Z 256 "${tempPreviewJpg}" --out "${previewPngPath}"`, {
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        previewCreated = true;
        break;
      } catch {}
    }
  }

  if (!previewCreated || !existsSync(previewPngPath)) {
    const localFiles = readdirSync(matDir);
    const baseColor = localFiles.find((f) => /base_?color|diff|alb/i.test(f) && !f.endsWith('.ktx2'));
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
  const allItems = await fetchJson('https://www.cgbookcase.com/api/textures');
  let items = allItems;
  if (targetCat) {
    items = items.filter((item) =>
      (item.categories || []).some((c) => c.toLowerCase() === targetCat) ||
      (item.tags || []).some((t) => t.toLowerCase() === targetCat)
    );
  }
  if (targetIds) {
    const targetSet = new Set(targetIds);
    items = items.filter(
      (item) =>
        targetSet.has(item.title.toLowerCase()) ||
        targetSet.has(toPascalCase(item.title).toLowerCase()) ||
        targetSet.has(String(item.id))
    );
  } else if (limit < items.length) {
    items = items.slice(0, limit);
  }

  const myItems = items.slice(sliceStart, sliceEnd);
  console.log(`[W${workerId}] Started processing ${myItems.length} items (${sliceStart}..${sliceEnd})...`);

  for (let i = 0; i < myItems.length; i++) {
    processItem(myItems[i], sliceStart + i, items.length, workerId);
  }
  console.log(`[W${workerId}] Completed slice!`);
}

async function runMaster() {
  console.log(`Fetching cgbookcase textures index (Master process)...`);
  const allItems = await fetchJson('https://www.cgbookcase.com/api/textures');

  let items = allItems;
  if (targetCat) {
    items = items.filter((item) =>
      (item.categories || []).some((c) => c.toLowerCase() === targetCat) ||
      (item.tags || []).some((t) => t.toLowerCase() === targetCat)
    );
  }
  if (targetIds) {
    const targetSet = new Set(targetIds);
    items = items.filter(
      (item) =>
        targetSet.has(item.title.toLowerCase()) ||
        targetSet.has(toPascalCase(item.title).toLowerCase()) ||
        targetSet.has(String(item.id))
    );
  } else if (limit < items.length) {
    items = items.slice(0, limit);
  }

  console.log(`Spawning ${CONCURRENCY} parallel worker processes for ${items.length} items...`);

  const chunkSize = Math.ceil(items.length / CONCURRENCY);
  const childPromises = [];

  for (let w = 0; w < CONCURRENCY; w++) {
    const sliceStart = w * chunkSize;
    const sliceEnd = Math.min(sliceStart + chunkSize, items.length);
    if (sliceStart >= items.length) break;

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
