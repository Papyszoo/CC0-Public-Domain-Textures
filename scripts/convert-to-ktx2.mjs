#!/usr/bin/env node
// Converts texture maps to max 512px (512x512) KTX2 (Khronos Texture 2.0 / Basis Universal)
// format for ultra-lightweight, zero-lag GPU streaming and fast scene composition in Modelibr.
//
// Usage:
//   node scripts/convert-to-ktx2.mjs --pack <slug>     # Convert all textures in a pack
//   node scripts/convert-to-ktx2.mjs --file <path>     # Convert a single texture file/dir
//   node scripts/convert-to-ktx2.mjs [--all]          # Convert all packs
//   node scripts/convert-to-ktx2.mjs --max-res 512    # Custom max dimension (default: 512)
//   node scripts/convert-to-ktx2.mjs --keep-source    # Keep original uncompressed image files

import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SOURCE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.tga', '.tif', '.tiff', '.bmp', '.webp', '.exr']);

const args = process.argv.slice(2);
const packArgIndex = args.indexOf('--pack');
const targetPack = packArgIndex !== -1 ? args[packArgIndex + 1] : null;
const fileArgIndex = args.indexOf('--file') !== -1 ? args.indexOf('--file') : args.indexOf('--dir');
const targetFile = fileArgIndex !== -1 ? args[fileArgIndex + 1] : null;
const maxResArgIndex = args.indexOf('--max-res');
const maxDimension = maxResArgIndex !== -1 ? parseInt(args[maxResArgIndex + 1], 10) : 512;
const keepSource = args.includes('--keep-source');

// Locate basisu binary
function findBasisu() {
  try {
    const p = execSync('which basisu', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    if (p && existsSync(p)) return p;
  } catch {}

  const possiblePaths = [
    '/Users/devmachine/.npm/_npx/05d36917fd65b472/node_modules/basisu/bin/darwin/arm64/basisu',
    path.join(REPO, 'node_modules/basisu/bin/darwin/arm64/basisu'),
    path.join(REPO, 'node_modules/basisu/bin/darwin/x64/basisu'),
    path.join(REPO, 'node_modules/basisu/bin/linux/x64/basisu'),
  ];

  for (const p of possiblePaths) {
    if (existsSync(p)) return p;
  }

  return 'basisu';
}

const BASISU_BIN = findBasisu();

function isNormalMap(filePath) {
  const stem = path.basename(filePath, path.extname(filePath)).toLowerCase();
  return (
    stem.includes('normal') ||
    stem.includes('_nor') ||
    stem.includes('_nrm') ||
    stem.includes('_norm') ||
    stem.endsWith('_n')
  );
}

function isLinearMap(filePath) {
  const stem = path.basename(filePath, path.extname(filePath)).toLowerCase();
  return (
    isNormalMap(filePath) ||
    stem.includes('roughness') ||
    stem.includes('rough') ||
    stem.includes('metallic') ||
    stem.includes('metalness') ||
    stem.includes('metal') ||
    stem.includes('height') ||
    stem.includes('displacement') ||
    stem.includes('disp') ||
    stem.includes('ambientocclusion') ||
    stem.includes('ao') ||
    stem.includes('occlusion')
  );
}

function isAlbedoMap(filePath) {
  const stem = path.basename(filePath, path.extname(filePath)).toLowerCase();
  return (
    stem.includes('albedo') ||
    stem.includes('basecolor') ||
    stem.includes('base_color') ||
    stem.includes('diffuse') ||
    stem.includes('col') ||
    stem.includes('color') ||
    stem.endsWith('_d')
  );
}

/**
 * Resize image if max dimension > maxDimension (default: 512).
 * Uses macOS `sips` when available.
 */
function downscaleToTarget(inputPath, outputPath) {
  try {
    const dimOutput = execSync(`sips -g pixelWidth -g pixelHeight "${inputPath}"`, {
      stdio: ['pipe', 'pipe', 'ignore'],
    }).toString();
    const wMatch = dimOutput.match(/pixelWidth:\s*(\d+)/);
    const hMatch = dimOutput.match(/pixelHeight:\s*(\d+)/);
    const width = wMatch ? parseInt(wMatch[1], 10) : 0;
    const height = hMatch ? parseInt(hMatch[1], 10) : 0;

    if (width > maxDimension || height > maxDimension) {
      console.log(`  Resizing from ${width}x${height} -> max ${maxDimension}px`);
      execSync(`sips -s format png -Z ${maxDimension} "${inputPath}" --out "${outputPath}"`, {
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      return true;
    }
  } catch (err) {}
  return false;
}

/**
 * Convert a single image file to .ktx2
 */
function convertFile(inputPath) {
  const ext = path.extname(inputPath).toLowerCase();
  if (!SOURCE_EXTS.has(ext)) return;

  const dir = path.dirname(inputPath);
  const stem = path.basename(inputPath, ext);
  const ktx2Path = path.join(dir, `${stem}.ktx2`);

  // Skip if cover or store preview
  if (stem === 'cover' || stem === 'store-preview' || stem.endsWith('_preview')) {
    return;
  }

  console.log(`Processing: ${path.relative(REPO, inputPath)}`);

  // Temporary downscaled copy if needed
  const tempResized = path.join(dir, `__temp_${stem}.png`);
  let sourceForBasisu = inputPath;

  const wasResized = downscaleToTarget(inputPath, tempResized);
  if (wasResized && existsSync(tempResized)) {
    sourceForBasisu = tempResized;
  }

  // Basis Universal encoder flags:
  // -ktx2: output KTX2 container
  // -uastc: Universal ASTC texture format (high fidelity PBR)
  // -uastc_rdo_l 1.0: Rate distortion optimization scalar (reduces file size further while preserving visual quality)
  // -mipmap: generate complete mipmap levels
  const flags = ['-ktx2', '-uastc', '-uastc_rdo_l 1.0', '-mipmap'];

  if (isNormalMap(inputPath)) {
    flags.push('-normal_map');
  } else if (isLinearMap(inputPath)) {
    flags.push('-linear');
  }

  const cmd = `"${BASISU_BIN}" ${flags.join(' ')} -file "${sourceForBasisu}" -output_file "${ktx2Path}"`;

  try {
    execSync(cmd, { stdio: ['pipe', 'pipe', 'inherit'] });
    console.log(`  -> Created ${path.relative(REPO, ktx2Path)} (${(statSync(ktx2Path).size / 1024).toFixed(1)} KB)`);

    // If this is an Albedo/Color map or general texture, also generate a 256px preview PNG for web catalog inspection
    if (isAlbedoMap(inputPath) || !isLinearMap(inputPath)) {
      const previewPngPath = path.join(dir, `${stem}_preview.png`);
      try {
        execSync(`sips -Z 256 "${inputPath}" --out "${previewPngPath}"`, { stdio: ['pipe', 'ignore', 'ignore'] });
        console.log(`  -> Generated preview thumbnail ${path.basename(previewPngPath)}`);
      } catch {}
    }

    if (!keepSource && existsSync(ktx2Path) && inputPath !== ktx2Path) {
      unlinkSync(inputPath);
    }
  } catch (err) {
    console.error(`  ERROR converting ${inputPath}:`, err.message);
  } finally {
    if (existsSync(tempResized)) {
      try {
        unlinkSync(tempResized);
      } catch {}
    }
  }
}

function processDirectory(dir) {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.name.startsWith('.') || entry.name.startsWith('__temp_')) continue;
    if (entry.isDirectory()) {
      processDirectory(fullPath);
    } else if (entry.isFile()) {
      convertFile(fullPath);
    }
  }
}

if (targetFile) {
  const absPath = path.resolve(process.cwd(), targetFile);
  if (!existsSync(absPath)) {
    console.error(`File not found: ${absPath}`);
    process.exit(1);
  }
  if (statSync(absPath).isDirectory()) {
    processDirectory(absPath);
  } else {
    convertFile(absPath);
  }
} else if (targetPack) {
  const packTexturesDir = path.join(REPO, 'packs', targetPack, 'textures');
  const packRootDir = path.join(REPO, 'packs', targetPack);
  if (existsSync(packTexturesDir)) {
    processDirectory(packTexturesDir);
  } else if (existsSync(packRootDir)) {
    processDirectory(packRootDir);
  } else {
    console.error(`Pack not found: ${targetPack}`);
    process.exit(1);
  }
} else {
  const packsDir = path.join(REPO, 'packs');
  if (existsSync(packsDir)) {
    processDirectory(packsDir);
  }
}

console.log(`\nTexture conversion to max ${maxDimension}px KTX2 completed.`);
