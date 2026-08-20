#!/usr/bin/env node
/**
 * fetch-sharetextures.mjs
 * Ingests CC0 PBR textures from ShareTextures.com (~1,776 textures)
 *
 * Strategy:
 *  - Enumerate full catalog via api2.sharetextures.com/api/v0/for-frontend/items
 *  - Filter to type=textures only (excludes models, atlases)
 *  - For each texture: download 1K ZIP, extract PBR maps, convert to KTX2, save preview
 *  - Output: packs/sharetextures-textures/textures/<slug>/
 *
 * Usage:
 *   node scripts/fetch-sharetextures.mjs [--concurrency 6] [--limit N]
 */

import { fileURLToPath } from 'url';
import { dirname, join, basename, extname } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'fs';
import { execSync, fork } from 'child_process';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { tmpdir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const PACK_DIR = join(REPO_ROOT, 'packs', 'sharetextures-textures');
const TEXTURES_DIR = join(PACK_DIR, 'textures');

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const _ci = args.indexOf('--concurrency');
const CONCURRENCY = _ci >= 0 ? parseInt(args[_ci + 1]) : 6;
const _li = args.indexOf('--limit');
const LIMIT = _li >= 0 ? parseInt(args[_li + 1]) : Infinity;
const IS_WORKER = args.includes('--worker');
const WORKER_SLICE = args.includes('--slice') ? parseInt(args[args.indexOf('--slice') + 1]) : 0;
const WORKER_TOTAL = args.includes('--total-workers') ? parseInt(args[args.indexOf('--total-workers') + 1]) : 1;
const CATALOG_PATH = args.includes('--catalog') ? args[args.indexOf('--catalog') + 1] : null;

// ── Constants ────────────────────────────────────────────────────────────────
const API_BASE = 'https://api2.sharetextures.com/api/v0';
const FILES_BASE = 'https://files.sharetextures.com/file/Share-Textures';
const IMAGES_BASE = 'https://images.sharetextures.com/u';

// ── Taxonomy mapping ─────────────────────────────────────────────────────────
const CATEGORY_MAP = {
  'metal': 'Metal > Clean & Polished',
  'wood': 'Wood > Planks & Boards',
  'concrete': 'Concrete & Plaster > Smooth Concrete',
  'brick': 'Brick > Standard Brick',
  'stone': 'Stone & Rock > Natural Rock',
  'ground': 'Ground & Terrain > Dirt & Soil',
  'fabric': 'Fabric & Leather > Woven & Cloth',
  'leather': 'Fabric & Leather > Leather',
  'floor': 'Tiles & Paving > Ceramic Tiles',
  'pavement': 'Tiles & Paving > Stone Pavers',
  'road': 'Man-made > Asphalt',
  'wall': 'Concrete & Plaster > Stucco & Plaster',
  'plaster': 'Concrete & Plaster > Stucco & Plaster',
  'roof': 'Roofing > Clay Shingles',
  'surfaceimperfection': 'Imperfections & Overlays > Scratches & Smudges',
  'plastic': 'Man-made > Plastic & Rubber',
  'paper': 'Man-made > Cardboard & Paper',
  'cardboard': 'Man-made > Cardboard & Paper',
  'food': 'Food > Cooked & Baked',
  'abstract': 'Other > General',
  'other': 'Other > General',
  'animals': 'Organic > Flesh & Skin',
  'gems': 'Stone & Rock > Natural Rock',
};

// Slug-prefix overrides (more specific than category)
const SLUG_PREFIX_MAP = {
  'finewood': 'Wood > Polished & Finished',
  'fine-wood': 'Wood > Polished & Finished',
  'wood-plank': 'Wood > Planks & Boards',
  'brick': 'Brick > Standard Brick',
  'marble': 'Stone & Rock > Natural Rock',
  'stone': 'Stone & Rock > Natural Rock',
  'rock': 'Stone & Rock > Natural Rock',
  'sand': 'Ground & Terrain > Sand',
  'grass': 'Ground & Terrain > Grass & Mud',
  'snow': 'Ground & Terrain > Snow & Ice',
  'ice': 'Ground & Terrain > Snow & Ice',
  'soil': 'Ground & Terrain > Dirt & Soil',
  'leather': 'Fabric & Leather > Leather',
  'asphalt': 'Man-made > Asphalt',
  'lava': 'Other > General',
  'iron': 'Metal > Clean & Polished',
  'steel': 'Metal > Clean & Polished',
  'rust': 'Metal > Rusted & Corroded',
  'ceramic': 'Tiles & Paving > Ceramic Tiles',
  'tile': 'Tiles & Paving > Ceramic Tiles',
  'cobble': 'Stone & Rock > Cobblestone',
  'pebble': 'Stone & Rock > Pebbles & Gravel',
  'gravel': 'Stone & Rock > Pebbles & Gravel',
};

function resolveCategory(slug, categorySlug) {
  const s = slug.toLowerCase();
  for (const [prefix, tax] of Object.entries(SLUG_PREFIX_MAP)) {
    if (s.startsWith(prefix)) return tax;
  }
  return CATEGORY_MAP[categorySlug] || 'Other > General';
}

const SUFFIX_MAP = {
  '_color': '_color', '_col': '_color', '_basecolor': '_color', '_base_color': '_color',
  '_albedo': '_color', '_diffuse': '_color', '_diff': '_color',
  '_normal': '_normal_opengl', '_normalgl': '_normal_opengl',
  '_normal_opengl': '_normal_opengl', '_nor': '_normal_opengl', '_nrm': '_normal_opengl',
  '_roughness': '_roughness', '_rough': '_roughness', '_rgh': '_roughness',
  '_metallic': '_metallic', '_metalness': '_metallic', '_metal': '_metallic', '_met': '_metallic',
  '_ao': '_ao', '_ambientocclusion': '_ao', '_ambient_occlusion': '_ao', '_occlusion': '_ao',
  '_height': '_height', '_displacement': '_height', '_disp': '_height', '_depth': '_height',
  '_opacity': '_opacity', '_alpha': '_opacity', '_mask': '_opacity',
  '_emissive': '_emissive', '_emission': '_emissive',
  '_specular': '_specular', '_spec': '_specular',
  '_bump': '_height',
};
const INVALID_SUFFIXES = ['_normal_directx', '_normaldx', '_dx', '_directx', '-normal_directx', '-normaldx', '-dx', '-directx'];

function normalizeMapName(filename, slug) {
  const ext = extname(filename).toLowerCase();
  const nameBase = basename(filename, ext).toLowerCase();
  if (INVALID_SUFFIXES.some(s => nameBase.endsWith(s))) return null;
  // Strip resolution markers at start or end, and convert hyphens to underscores for suffix checking
  const withoutRes = nameBase
    .replace(/^([1248]k|\d{3,4})[-_]/i, '')
    .replace(/[-_]([1248]k|\d{3,4})$/i, '')
    .replace(/[-]/g, '_');
  for (const [suffix, normalized] of Object.entries(SUFFIX_MAP)) {
    if (withoutRes.endsWith(suffix)) return `${slug}${normalized}_1k${ext}`;
  }
  return null;
}

function findFiles(dir) {
  const results = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fp = join(dir, entry.name);
      if (entry.isDirectory()) results.push(...findFiles(fp));
      else results.push(fp);
    }
  } catch {}
  return results;
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────
async function fetchJson(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 CC0-Ingestor/1.0' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 800 * (i + 1)));
    }
  }
}

async function downloadFile(url, dest, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 CC0-Ingestor/1.0' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const fileStream = createWriteStream(dest);
      await pipeline(res.body, fileStream);
      return true;
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 800 * (i + 1)));
    }
  }
}

// ── Catalog enumeration ───────────────────────────────────────────────────────
async function enumerateAllTextures() {
  console.log('Fetching full texture catalog from ShareTextures API...');
  
  const allItems = [];
  const seen = new Set();
  let page = 1;
  let totalPages = 1;
  let skippedModels = 0;
  
  do {
    const url = `${API_BASE}/for-frontend/items?type=textures&page=${page}&perPage=100`;
    let data;
    try {
      data = await fetchJson(url);
    } catch (e) {
      console.warn(`  Warning: API call failed on page ${page}: ${e.message}`);
      break;
    }
    
    const inner = data?.data;
    if (!inner || !inner.items) break;
    
    if (page === 1) {
      totalPages = inner.pagination?.totalPage || 1;
      console.log(`  Total: ${inner.pagination?.totalCount} items across ${totalPages} pages (100/page)`);
    }
    
    for (const item of inner.items) {
      // Filter: only ingest actual PBR texture items, skip 3D models
      const itemTypeSlug = item?.itemType?.slug || item?.itemTypeName?.toLowerCase() || 'textures';
      if (itemTypeSlug !== 'textures') {
        skippedModels++;
        continue;
      }
      if (!seen.has(item.slug)) {
        seen.add(item.slug);
        allItems.push({
          slug: item.slug,
          title: item.title,
          categorySlug: item?.category?.slug || 'other',
          categoryName: item?.category?.name || 'Other',
        });
      }
    }
    
    process.stdout.write(`\r  Enumerated: ${allItems.length} textures (page ${page}/${totalPages})...`);
    page++;
    await new Promise(r => setTimeout(r, 150));
    
  } while (page <= totalPages);
  
  process.stdout.write('\n');
  if (skippedModels > 0) console.log(`  Skipped ${skippedModels} non-texture items (models, etc.)`);
  console.log(`  Final catalog: ${allItems.length} unique textures.\n`);
  return allItems;
}

// ── Single texture processing ─────────────────────────────────────────────────
const convertScript = join(__dirname, 'convert-to-ktx2.mjs');

async function processTexture(item, index, total, workerLabel) {
  const { slug, title, categorySlug } = item;
  const outDir = join(TEXTURES_DIR, slug);
  
  // Resume support: skip if already has KTX2 output
  if (existsSync(outDir) && readdirSync(outDir).some(f => f.endsWith('.ktx2'))) {
    return { slug, status: 'skipped' };
  }
  
  console.log(`[${index}/${total}]${workerLabel} ${title} (${slug})`);
  mkdirSync(outDir, { recursive: true });
  
  const tmpDir = join(tmpdir(), `st-${slug}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const zipPath = join(tmpDir, `${slug}.zip`);
  
  // Build slug for file server (underscores or hyphens)
  const fileSlug = slug.replace(/-/g, '_');
  
  // 1. Download 1K ZIP — try standard variants
  let downloaded = false;
  for (const variant of [`${slug}-1K.zip`, `${fileSlug}-1K.zip`, `${slug}.zip`, `${fileSlug}.zip`]) {
    try {
      await downloadFile(`${FILES_BASE}/${variant}`, zipPath);
      downloaded = true;
      break;
    } catch { /* try next variant */ }
  }
  
  // 2. Fallback: query API item detail for exact downloadLinks
  let itemDetails = null;
  if (!downloaded) {
    try {
      const itemRes = await fetchJson(`${API_BASE}/for-frontend/item/${slug}`);
      itemDetails = itemRes?.data;
      const links = itemDetails?.downloadLinks || [];
      const zipLinks = links.filter(l => l.value && l.value.includes('.zip'));
      const targetLink = zipLinks.find(l => /1k/i.test(l.title || '')) ||
                         zipLinks.find(l => /2k/i.test(l.title || '')) ||
                         zipLinks[0];
      if (targetLink?.value) {
        await downloadFile(targetLink.value, zipPath);
        downloaded = true;
      }
    } catch (e) {
      // ignore
    }
  }
  
  if (!downloaded) {
    console.warn(`  [SKIP] ${slug}: no downloadable ZIP found`);
    try { execSync(`rm -rf "${tmpDir}"`, { stdio: 'pipe' }); } catch {}
    try { if (existsSync(outDir) && readdirSync(outDir).length === 0) rmSync(outDir, { recursive: true, force: true }); } catch {}
    return { slug, status: 'failed', error: 'no zip' };
  }
  
  // Extract ZIP
  try {
    execSync(`unzip -o -q "${zipPath}" -d "${tmpDir}/extracted"`, { stdio: 'pipe' });
  } catch {
    console.warn(`  [SKIP] ${slug}: unzip failed`);
    try { execSync(`rm -rf "${tmpDir}"`, { stdio: 'pipe' }); } catch {}
    try { if (existsSync(outDir) && readdirSync(outDir).length === 0) rmSync(outDir, { recursive: true, force: true }); } catch {}
    return { slug, status: 'failed', error: 'unzip failed' };
  }
  
  // Find and copy PBR maps
  const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.tga', '.tif', '.tiff', '.bmp']);
  const allFiles = findFiles(join(tmpDir, 'extracted'));
  let copied = 0;
  
  for (const file of allFiles) {
    const ext = extname(file).toLowerCase();
    if (!IMG_EXTS.has(ext)) continue;
    if (file.includes('__MACOSX') || basename(file).startsWith('.')) continue;
    const cleanName = normalizeMapName(basename(file), slug);
    if (!cleanName) continue;
    try {
      execSync(`cp "${file}" "${join(outDir, cleanName)}"`, { stdio: 'pipe' });
      copied++;
    } catch {}
  }
  
  if (copied === 0) {
    // No recognized PBR maps — still try to save whatever images are there
    let fallbackCopied = 0;
    for (const file of allFiles) {
      const ext = extname(file).toLowerCase();
      if (!IMG_EXTS.has(ext)) continue;
      if (file.includes('__MACOSX') || basename(file).startsWith('.')) continue;
      try {
        execSync(`cp "${file}" "${join(outDir, basename(file))}"`, { stdio: 'pipe' });
        fallbackCopied++;
      } catch {}
    }
    if (fallbackCopied === 0) {
      console.warn(`  [SKIP] ${slug}: no image files found`);
      try { execSync(`rm -rf "${tmpDir}"`, { stdio: 'pipe' }); } catch {}
      try { if (existsSync(outDir) && readdirSync(outDir).length === 0) rmSync(outDir, { recursive: true, force: true }); } catch {}
      return { slug, status: 'failed', error: 'no images' };
    }
    console.warn(`  [WARN] ${slug}: copied ${fallbackCopied} files without map normalization`);
  }
  
  // Download preview thumbnail
  for (const pUrl of [
    `${IMAGES_BASE}/${slug.replace(/-/g, '_')}.webp`,
    `${IMAGES_BASE}/${slug}.webp`,
    itemDetails?.previewImage1?.originalObjectKey ? `https://images.sharetextures.com/${itemDetails.previewImage1.originalObjectKey}` : null,
    itemDetails?.previewImage1?.thumbObjectKey ? `https://images.sharetextures.com/${itemDetails.previewImage1.thumbObjectKey}` : null,
  ].filter(Boolean)) {
    try {
      await downloadFile(pUrl, join(outDir, `${slug}_preview.webp`));
      break;
    } catch {}
  }
  
  // Write metadata files
  const taxonomy = resolveCategory(slug, categorySlug);
  writeFileSync(join(outDir, `${slug}_description.txt`), title);
  writeFileSync(join(outDir, `${slug}_category.txt`), taxonomy);
  writeFileSync(join(outDir, `${slug}_keywords.txt`), [
    categorySlug,
    slug.replace(/-\d+$/, '').replace(/_\d+$/, ''),
    title.toLowerCase(),
  ].join('\n'));
  
  // Convert to KTX2
  try {
    execSync(`node "${convertScript}" --dir "${outDir}"`, { cwd: REPO_ROOT, stdio: 'pipe' });
  } catch {
    console.warn(`  [WARN] ${slug}: KTX2 conversion failed (source files preserved)`);
  }
  
  try { execSync(`rm -rf "${tmpDir}"`, { stdio: 'pipe' }); } catch {}
  return { slug, status: 'ok' };
}

// ── Worker ────────────────────────────────────────────────────────────────────
async function runWorker() {
  const items = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  const myItems = items.filter((_, i) => i % WORKER_TOTAL === WORKER_SLICE);
  const label = ` [W${WORKER_SLICE}]`;
  console.log(`${label} Slice ${WORKER_SLICE}/${WORKER_TOTAL}: ${myItems.length} textures`);
  for (const [i, item] of myItems.entries()) {
    await processTexture(item, i + 1, myItems.length, label);
  }
  console.log(`${label} Done!`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(TEXTURES_DIR, { recursive: true });
  
  const packJson = join(PACK_DIR, 'pack.json');
  if (!existsSync(packJson)) {
    writeFileSync(packJson, JSON.stringify({
      name: 'ShareTextures CC0 PBR Textures',
      slug: 'sharetextures-textures',
      creator: 'Share Textures',
      website: 'https://www.sharetextures.com',
      license: 'CC0',
      description: 'Free CC0 PBR texture materials from ShareTextures.com. Covers metal, wood, concrete, fabric, floors, walls, and more — full PBR channel sets.',
      upstream: {
        source_url: 'https://www.sharetextures.com/textures',
        download_url: 'https://files.sharetextures.com',
        available_resolutions: ['1k', '2k', '4k'],
      },
    }, null, 2));
  }
  
  let items = await enumerateAllTextures();
  
  if (isFinite(LIMIT)) {
    items = items.slice(0, LIMIT);
    console.log(`Limited to ${items.length} textures.\n`);
  }
  
  console.log(`Starting ingestion of ${items.length} textures (${CONCURRENCY} workers)...\n`);
  
  const catalogPath = join(PACK_DIR, '.catalog.json');
  writeFileSync(catalogPath, JSON.stringify(items));
  
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    const w = fork(fileURLToPath(import.meta.url), [
      '--worker',
      '--slice', String(i),
      '--total-workers', String(CONCURRENCY),
      '--catalog', catalogPath,
    ], { cwd: REPO_ROOT });
    workers.push(w);
  }
  
  await Promise.all(workers.map(w => new Promise((res, rej) => {
    w.on('exit', code => code === 0 ? res() : rej(new Error(`Worker exited ${code}`)));
  })));
  
  console.log('\nAll workers done! Generating store manifests...');
  execSync('node scripts/generate-store-manifest.mjs --root', { cwd: REPO_ROOT, stdio: 'inherit' });
}

// ── Entry ─────────────────────────────────────────────────────────────────────
if (IS_WORKER) {
  runWorker().catch(e => { console.error(e); process.exit(1); });
} else {
  main().catch(e => { console.error(e); process.exit(1); });
}
