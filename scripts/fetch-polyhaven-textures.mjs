#!/usr/bin/env node
// Downloads, converts to max 1k KTX2, and generates manifests for Poly Haven CC0 PBR textures.
// All Poly Haven materials are consolidated into packs/polyhaven-textures/ ("one source - one pack").
//
// Usage:
//   node scripts/fetch-polyhaven-textures.mjs --limit 10          # Download top 10 popular textures
//   node scripts/fetch-polyhaven-textures.mjs --ids aerial_rocks_02,brick_wall_001
//   node scripts/fetch-polyhaven-textures.mjs --category wood --limit 5
//   node scripts/fetch-polyhaven-textures.mjs --all               # Download all Poly Haven textures

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PACK_SLUG = 'polyhaven-textures';
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
  console.log('Fetching Poly Haven textures index...');
  const allAssets = await fetchJson('https://api.polyhaven.com/assets?t=textures');

  let assetKeys = Object.keys(allAssets);

  if (targetIds) {
    assetKeys = assetKeys.filter((k) => targetIds.includes(k));
  } else {
    // Sort by popularity (download_count descending)
    assetKeys.sort((a, b) => (allAssets[b].download_count || 0) - (allAssets[a].download_count || 0));

    if (targetCat) {
      assetKeys = assetKeys.filter((k) => {
        const cat = (allAssets[k].category || '').toLowerCase();
        const cats = (allAssets[k].categories || []).map((c) => c.toLowerCase());
        const tags = (allAssets[k].tags || []).map((t) => t.toLowerCase());
        return cat.includes(targetCat) || cats.some((c) => c.includes(targetCat)) || tags.some((t) => t.includes(targetCat));
      });
    }

    if (limit < assetKeys.length) {
      assetKeys = assetKeys.slice(0, limit);
    }
  }

  console.log(`Found ${assetKeys.length} Poly Haven texture(s) to process.`);

  const upstreamItems = {};

  for (let i = 0; i < assetKeys.length; i++) {
    const id = assetKeys[i];
    const info = allAssets[id];
    const matDir = path.join(TEXTURES_DIR, id);
    const previewPngPath = path.join(matDir, `${id}_preview.png`);

    // Check if already processed
    if (existsSync(matDir) && existsSync(previewPngPath)) {
      const existingFiles = readdirSync(matDir);
      if (existingFiles.some((f) => f.endsWith('.ktx2'))) {
        // Already processed
        upstreamItems[id] = {
          name: info.name || id,
          source_url: `https://polyhaven.com/a/${id}`,
          download_url: `https://polyhaven.com/a/${id}`,
          available_resolutions: ['1k', '2k', '4k', '8k', ...(info.max_resolution?.[0] >= 16384 ? ['16k'] : [])],
          categories: info.categories || [],
          tags: info.tags || [],
        };
        continue;
      }
    }

    console.log(`\n[${i + 1}/${assetKeys.length}] Processing: ${info.name || id} (${id})`);
    mkdirSync(matDir, { recursive: true });

    // Fetch file URLs for this asset
    let filesInfo = {};
    try {
      filesInfo = await fetchJson(`https://api.polyhaven.com/files/${id}`);
    } catch (err) {
      console.warn(`  Failed to fetch files index for ${id}:`, err.message);
      continue;
    }

    // Map channels to download (1k resolution)
    // Priority: Diffuse / Albedo, nor_gl / nor_dx, rough, metal, ao, disp
    const channelMap = [
      { key: 'Diffuse', nameSuffix: 'albedo', altKeys: ['Albedo', 'BaseColor', 'Col'] },
      { key: 'nor_gl', nameSuffix: 'normal', altKeys: ['nor_dx', 'Normal', 'nor'] },
      { key: 'rough', nameSuffix: 'roughness', altKeys: ['Roughness', 'Rough'] },
      { key: 'metal', nameSuffix: 'metallic', altKeys: ['Metallic', 'Metalness', 'Metal'] },
      { key: 'ao', nameSuffix: 'ao', altKeys: ['AO', 'AmbientOcclusion'] },
      { key: 'disp', nameSuffix: 'height', altKeys: ['Displacement', 'Height'] },
    ];

    for (const ch of channelMap) {
      let fileData = filesInfo[ch.key]?.['1k'] || null;
      if (!fileData) {
        for (const alt of ch.altKeys) {
          if (filesInfo[alt]?.['1k']) {
            fileData = filesInfo[alt]['1k'];
            break;
          }
        }
      }

      if (fileData) {
        // Pick PNG first, fallback to JPG
        const formatObj = fileData.png || fileData.jpg;
        if (formatObj?.url) {
          const ext = fileData.png ? '.png' : '.jpg';
          const destPath = path.join(matDir, `${id}_${ch.nameSuffix}${ext}`);
          downloadFile(formatObj.url, destPath);
        }
      }
    }

    // Convert raw maps in this material folder to max 1k KTX2
    execSync(`node "${path.join(SCRIPTS_DIR, 'convert-to-ktx2.mjs')}" --file "${matDir}" 2>/dev/null || node "${path.join(SCRIPTS_DIR, 'convert-to-ktx2.mjs')}" --pack "${PACK_SLUG}"`, {
      stdio: 'inherit',
    });

    // Download official 3D material sphere render from Poly Haven
    const thumbUrl = info.thumbnail_url || `https://cdn.polyhaven.com/asset_img/primary/${id}.png`;
    downloadFile(thumbUrl, previewPngPath);
    if (existsSync(previewPngPath)) {
      try {
        execSync(`sips -Z 256 "${previewPngPath}"`, { stdio: ['ignore', 'ignore', 'ignore'] });
      } catch {}
    }

    upstreamItems[id] = {
      name: info.name || id,
      source_url: `https://polyhaven.com/a/${id}`,
      download_url: `https://polyhaven.com/a/${id}`,
      available_resolutions: ['1k', '2k', '4k', '8k', ...(info.max_resolution?.[0] >= 16384 ? ['16k'] : [])],
      categories: info.categories || [],
      tags: info.tags || [],
    };
  }

  // Ensure cover image exists
  const coverPath = path.join(PACK_DIR, 'cover.png');
  if (!existsSync(coverPath) && assetKeys.length > 0) {
    const firstId = assetKeys[0];
    const thumbUrl = allAssets[firstId]?.thumbnail_url || `https://cdn.polyhaven.com/asset_img/primary/${firstId}.png`;
    console.log(`Fetching pack cover artwork from ${thumbUrl}...`);
    downloadFile(thumbUrl, coverPath);
  }

  // Write pack.json
  const packMeta = {
    name: 'Poly Haven PBR Textures',
    creator: 'Poly Haven',
    website: 'https://polyhaven.com/textures',
    license: 'CC0',
    description: 'Curated collection of 100% CC0 photorealistic PBR materials by Poly Haven (polyhaven.com) in max 512px KTX2 format with full mipmaps for fast scene prototyping and low VRAM usage. High-resolution master files (up to 8K/16K) available via original source links.',
    upstream: {
      source_url: 'https://polyhaven.com/textures',
      download_url: 'https://polyhaven.com/textures',
      available_resolutions: ['1k', '2k', '4k', '8k', '16k'],
    },
    generation: {
      category: 'Stone & Rock',
      subcategory: 'Natural Rock',
    },
  };
  writeFileSync(path.join(PACK_DIR, 'pack.json'), JSON.stringify(packMeta, null, 2) + '\n');

  // Generate store manifest
  console.log('\nGenerating store manifest for Poly Haven textures pack...');
  execSync(`node "${path.join(SCRIPTS_DIR, 'generate-store-manifest.mjs')}" --pack "${PACK_SLUG}"`, {
    stdio: 'inherit',
  });

  console.log(`\nSuccessfully ingested Poly Haven textures into packs/${PACK_SLUG}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
