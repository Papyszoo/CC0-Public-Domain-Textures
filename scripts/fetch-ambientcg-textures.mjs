#!/usr/bin/env node
// Downloads, converts to max 1k KTX2, and generates manifests for AmbientCG CC0 PBR textures.
// All AmbientCG materials are consolidated into packs/ambientcg-textures/ ("one source - one pack").
//
// Usage:
//   node scripts/fetch-ambientcg-textures.mjs --limit 10          # Download top 10 popular materials
//   node scripts/fetch-ambientcg-textures.mjs --ids Ground108,Rock030
//   node scripts/fetch-ambientcg-textures.mjs --category Wood --limit 5
//   node scripts/fetch-ambientcg-textures.mjs --all               # Download all AmbientCG materials

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PACK_SLUG = 'ambientcg-textures';
const PACK_DIR = path.join(REPO, 'packs', PACK_SLUG);
const TEXTURES_DIR = path.join(PACK_DIR, 'textures');
const SCRIPTS_DIR = path.join(REPO, 'scripts');

mkdirSync(TEXTURES_DIR, { recursive: true });

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : (args.includes('--all') ? Infinity : 20);
const idsIdx = args.indexOf('--ids');
const targetIds = idsIdx !== -1 ? args[idsIdx + 1].split(',').map((s) => s.trim()) : null;
const catIdx = args.indexOf('--category');
const targetCat = catIdx !== -1 ? args[catIdx + 1].toLowerCase() : null;

async function fetchJson(url) {
  const output = execSync(`curl -sL "${url}"`, { maxBuffer: 20 * 1024 * 1024 }).toString();
  return JSON.parse(output);
}

function downloadFile(url, destPath) {
  if (existsSync(destPath)) return true;
  try {
    execSync(`curl -sL -o "${destPath}" "${url}"`, { stdio: ['ignore', 'ignore', 'inherit'] });
    return true;
  } catch (err) {
    console.error(`Failed to download ${url}:`, err.message);
    return false;
  }
}

async function main() {
  console.log('Fetching AmbientCG materials index...');
  let queryUrl = 'https://ambientcg.com/api/v2/full_json?sort=Popular&limit=100';
  if (targetCat) {
    queryUrl += `&q=${encodeURIComponent(targetCat)}`;
  }

  const res = await fetchJson(queryUrl);
  let assets = res.foundAssets || [];

  if (targetIds) {
    const targetSet = new Set(targetIds.map((s) => s.toLowerCase()));
    assets = assets.filter((a) => targetSet.has(a.assetId.toLowerCase()));
  } else if (limit < assets.length) {
    assets = assets.slice(0, limit);
  }

  console.log(`Found ${assets.length} AmbientCG material(s) to process.`);

  const tempZipDir = path.join(REPO, 'packs', '__temp_ambientcg_zips');
  mkdirSync(tempZipDir, { recursive: true });

  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    const assetId = asset.assetId;
    console.log(`\n[${i + 1}/${assets.length}] Processing: ${assetId}`);

    const matDir = path.join(TEXTURES_DIR, assetId);
    mkdirSync(matDir, { recursive: true });

    // Download 1K-PNG zip
    const zipUrl = `https://ambientcg.com/get?file=${assetId}_1K-PNG.zip`;
    const zipDest = path.join(tempZipDir, `${assetId}.zip`);

    console.log(`  Downloading ${zipUrl}...`);
    const downloaded = downloadFile(zipUrl, zipDest);
    if (!downloaded || !existsSync(zipDest)) {
      console.warn(`  Skipping ${assetId} (download failed)`);
      continue;
    }

    // Extract into matDir
    try {
      execSync(`unzip -o -q "${zipDest}" -d "${matDir}"`, { stdio: 'inherit' });
    } catch (err) {
      console.error(`  Failed to extract ${zipDest}:`, err.message);
      continue;
    }

    // Clean up non-image / extra files
    const extractedFiles = readdirSync(matDir);
    let hasNormalGl = false;

    for (const f of extractedFiles) {
      const fLower = f.toLowerCase();
      if (fLower.includes('normalgl')) hasNormalGl = true;
    }

    for (const f of extractedFiles) {
      const fPath = path.join(matDir, f);
      const ext = path.extname(f).toLowerCase();

      // Remove 3D / DCC files
      if (ext === '.usdc' || ext === '.blend' || ext === '.mtlx' || ext === '.tres') {
        try { unlinkSync(fPath); } catch {}
        continue;
      }

      // If we have NormalGL, remove NormalDX to avoid redundant duplicate normals
      if (hasNormalGl && f.toLowerCase().includes('normaldx')) {
        try { unlinkSync(fPath); } catch {}
        continue;
      }
    }

    // Convert raw maps to max 1k KTX2
    execSync(`node "${path.join(SCRIPTS_DIR, 'convert-to-ktx2.mjs')}" --file "${matDir}" 2>/dev/null || node "${path.join(SCRIPTS_DIR, 'convert-to-ktx2.mjs')}" --pack "${PACK_SLUG}"`, {
      stdio: 'inherit',
    });

    try { unlinkSync(zipDest); } catch {}
  }

  try { rmSync(tempZipDir, { recursive: true, force: true }); } catch {}

  // Ensure cover image exists
  const coverPath = path.join(PACK_DIR, 'cover.png');
  if (!existsSync(coverPath) && assets.length > 0) {
    const firstAsset = assets[0];
    const previewUrl = firstAsset.previewImage?.['1024-PNG'] || firstAsset.previewImage?.['512-PNG'];
    if (previewUrl) {
      console.log(`Fetching pack cover artwork from ${previewUrl}...`);
      downloadFile(previewUrl, coverPath);
    }
  }

  // Write pack.json
  const packMeta = {
    name: 'AmbientCG PBR Textures',
    creator: 'AmbientCG (Lennart Demes)',
    website: 'https://ambientcg.com',
    license: 'CC0',
    description: 'Extensive collection of 100% CC0 public domain PBR materials and surface textures by Lennart Demes (ambientcg.com) in max 512px KTX2 format with full mipmaps for fast scene prototyping and low VRAM usage. Master resolutions (up to 8K/12K) available via original source links.',
    upstream: {
      source_url: 'https://ambientcg.com',
      download_url: 'https://ambientcg.com',
      available_resolutions: ['1k', '2k', '4k', '8k', '12k'],
    },
    generation: {
      category: 'Stone & Rock',
      subcategory: 'Natural Rock',
    },
  };
  writeFileSync(path.join(PACK_DIR, 'pack.json'), JSON.stringify(packMeta, null, 2) + '\n');

  // Generate store manifest
  console.log('\nGenerating store manifest for AmbientCG textures pack...');
  execSync(`node "${path.join(SCRIPTS_DIR, 'generate-store-manifest.mjs')}" --pack "${PACK_SLUG}"`, {
    stdio: 'inherit',
  });

  console.log(`\nSuccessfully ingested AmbientCG textures into packs/${PACK_SLUG}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
