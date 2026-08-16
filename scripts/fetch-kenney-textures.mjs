#!/usr/bin/env node
// Downloads, converts to max 1k KTX2, and generates manifests for Kenney CC0 texture packs.
// Each Kenney kit is stored in its own pack directory (e.g. packs/kenney-prototype-textures/).
//
// Usage:
//   node scripts/fetch-kenney-textures.mjs [--all]
//   node scripts/fetch-kenney-textures.mjs <pack-slug>

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PACKS_DIR = path.join(REPO, 'packs');
const SCRIPTS_DIR = path.join(REPO, 'scripts');

const args = process.argv.slice(2);

const KENNEY_TEXTURE_PACKS = [
  {
    slug: 'kenney-prototype-textures',
    name: 'Prototype Textures',
    pageUrl: 'https://kenney.nl/assets/prototype-textures',
    description: 'Universal development and blockout grid prototype textures (dark, light, orange, green, red, purple grids with meter units) by Kenney (kenney.nl) in max 512px KTX2 format. CC0 1.0 Universal.',
    category: 'Man-made',
    subcategory: 'Plastic & Rubber',
    preferSubdir: 'PNG',
  },
  {
    slug: 'kenney-particle-pack',
    name: 'Particle Textures Pack',
    pageUrl: 'https://kenney.nl/assets/particle-pack',
    description: 'Over 80 particle, fire, smoke, star, flare, spark, and VFX textures by Kenney (kenney.nl) in max 512px KTX2 format. CC0 1.0 Universal.',
    category: 'Imperfections & Overlays',
    subcategory: 'Decals & Stains',
    preferSubdir: 'PNG (Transparent)',
  },
];

async function fetchPageInfo(pageUrl) {
  const html = execSync(`curl -sL "${pageUrl}"`, { maxBuffer: 10 * 1024 * 1024 }).toString();

  const zipMatch = html.match(/href='(https:\/\/kenney\.nl\/media\/pages\/assets\/[^']*\.zip)'/);
  const zipUrl = zipMatch ? zipMatch[1] : null;

  let coverUrl = null;
  const sampleMatch = html.match(/(https:\/\/kenney\.nl\/media\/pages\/assets\/[^'"]*sample\.png)/);
  const previewMatch = html.match(/(https:\/\/kenney\.nl\/media\/pages\/assets\/[^'"]*preview[^'"]*\.png)/);
  const ogMatch = html.match(/og:image'\s*content='([^']*)'/);

  if (sampleMatch) coverUrl = sampleMatch[1];
  else if (previewMatch) coverUrl = previewMatch[1];
  else if (ogMatch) coverUrl = ogMatch[1];

  return { zipUrl, coverUrl };
}

function findBestTextureDir(extractDir, preferSubdir) {
  if (preferSubdir && existsSync(path.join(extractDir, preferSubdir))) {
    return path.join(extractDir, preferSubdir);
  }
  const candidates = [
    'PNG (Transparent)',
    'PNG/Transparent',
    'PNG',
    'Textures',
  ];
  for (const c of candidates) {
    if (existsSync(path.join(extractDir, c))) {
      return path.join(extractDir, c);
    }
  }
  return extractDir;
}

function copyAllImages(srcDir, destDir) {
  if (!existsSync(srcDir)) return;
  const entries = readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      copyAllImages(srcPath, destDir);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
        copyFileSync(srcPath, path.join(destDir, entry.name));
      }
    }
  }
}

async function processPack(packDef) {
  console.log(`\n========================================`);
  console.log(`Processing Kenney pack: ${packDef.name} (${packDef.slug})`);
  console.log(`========================================`);

  const packDir = path.join(PACKS_DIR, packDef.slug);
  const texturesDir = path.join(packDir, 'textures');
  mkdirSync(texturesDir, { recursive: true });

  const { zipUrl, coverUrl } = await fetchPageInfo(packDef.pageUrl);
  if (!zipUrl) {
    console.error(`Could not find zip download URL on ${packDef.pageUrl}`);
    return;
  }

  const tempZip = path.join(REPO, `__temp_${packDef.slug}.zip`);
  const tempExtract = path.join(REPO, `__temp_${packDef.slug}_extracted`);

  try {
    console.log(`Downloading zip from ${zipUrl}...`);
    execSync(`curl -sL -o "${tempZip}" "${zipUrl}"`, { stdio: 'inherit' });

    mkdirSync(tempExtract, { recursive: true });
    execSync(`unzip -o -q "${tempZip}" -d "${tempExtract}"`, { stdio: 'inherit' });

    const sourceDir = findBestTextureDir(tempExtract, packDef.preferSubdir);
    console.log(`Copying images from ${path.relative(REPO, sourceDir)} to textures/ ...`);
    copyAllImages(sourceDir, texturesDir);

    // Download cover artwork
    const coverDest = path.join(packDir, 'cover.png');
    if (coverUrl && !existsSync(coverDest)) {
      console.log(`Downloading cover artwork from ${coverUrl}...`);
      execSync(`curl -sL -o "${coverDest}" "${coverUrl}"`, { stdio: 'inherit' });
    }

    // Write pack.json
    const packMeta = {
      name: `Kenney: ${packDef.name}`,
      creator: 'Kenney',
      website: packDef.pageUrl,
      license: 'CC0',
      description: packDef.description,
      upstream: {
        source_url: packDef.pageUrl,
        download_url: packDef.pageUrl,
        available_resolutions: ['1k'],
      },
      generation: {
        category: packDef.category,
        subcategory: packDef.subcategory,
      },
    };
    writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify(packMeta, null, 2) + '\n');

    // Convert textures to max 1k KTX2
    console.log('Converting textures to max 1k KTX2...');
    execSync(`node "${path.join(SCRIPTS_DIR, 'convert-to-ktx2.mjs')}" --pack "${packDef.slug}"`, {
      stdio: 'inherit',
    });

    // Generate store manifest
    console.log('Generating store manifest...');
    execSync(`node "${path.join(SCRIPTS_DIR, 'generate-store-manifest.mjs')}" --pack "${packDef.slug}"`, {
      stdio: 'inherit',
    });

    console.log(`Done processing ${packDef.slug}!`);
  } finally {
    try { if (existsSync(tempZip)) rmSync(tempZip); } catch {}
    try { if (existsSync(tempExtract)) rmSync(tempExtract, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  const targetSlug = args.find((a) => !a.startsWith('--'));
  if (targetSlug) {
    const pack = KENNEY_TEXTURE_PACKS.find((p) => p.slug === targetSlug || p.slug.replace('kenney-', '') === targetSlug);
    if (!pack) {
      console.error(`Unknown Kenney pack slug: ${targetSlug}`);
      process.exit(1);
    }
    await processPack(pack);
  } else {
    for (const pack of KENNEY_TEXTURE_PACKS) {
      await processPack(pack);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
