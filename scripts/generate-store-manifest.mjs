#!/usr/bin/env node
// Generates store-manifest.json per pack (inside packs/<slug>/store-manifest.json):
// the ModelibrStore "external pack" manifest for each texture pack under packs/.
//
// Usage:
//   node scripts/generate-store-manifest.mjs --pack <slug>   # Generate manifest for one pack
//   node scripts/generate-store-manifest.mjs [--all]        # Generate manifests for all packs
//   node scripts/generate-store-manifest.mjs --root         # Also write combined root store-manifest.json

import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OWNER_REPO = 'Papyszoo/CC0-Public-Domain-Textures';

const IMAGE_EXTENSIONS = new Set(['.ktx2', '.png', '.jpg', '.jpeg', '.webp', '.tga', '.tif', '.tiff', '.exr', '.bmp']);

const args = process.argv.slice(2);
const packArgIndex = args.indexOf('--pack');
const targetPackSlug = packArgIndex !== -1 ? args[packArgIndex + 1] : null;
const writeRoot = args.includes('--root');

// ---------------------------------------------------------------------------
// Standard TextureSet categories & subcategories (ModelibrStore docs/taxonomy.json v1).
// ---------------------------------------------------------------------------
const TEXTURE_TAXONOMY = {
  Wood: ['Planks & Boards', 'Bark & Natural', 'Polished & Finished', 'Rough & Weathered'],
  Metal: ['Clean & Polished', 'Rusted & Corroded', 'Painted', 'Grates & Panels'],
  'Stone & Rock': ['Cobblestone', 'Natural Rock', 'Carved & Masonry', 'Pebbles & Gravel'],
  Brick: ['Standard Brick', 'Crumbling & Aged', 'Painted Brick', 'Pavers'],
  'Concrete & Plaster': ['Smooth Concrete', 'Rough & Weathered', 'Stucco & Plaster', 'Damaged Concrete'],
  'Ground & Terrain': ['Dirt & Soil', 'Grass & Mud', 'Sand', 'Snow & Ice'],
  'Fabric & Leather': ['Woven & Cloth', 'Leather', 'Denim & Canvas', 'Patterns'],
  'Tiles & Paving': ['Ceramic Tiles', 'Stone Pavers', 'Mosaic', 'Subway Tiles'],
  Roofing: ['Clay Shingles', 'Metal Roofing', 'Thatch', 'Slate'],
  Electronics: ['Circuit Boards & Chips', 'Panels & Displays', 'Wires & Cables'],
  Food: ['Cooked & Baked', 'Sweets & Candy', 'Fruits & Vegetables'],
  Organic: ['Flesh & Skin', 'Scales', 'Flora & Vegetation', 'Bark', 'Coral'],
  'Man-made': ['Plastic & Rubber', 'Glass', 'Asphalt', 'Cardboard & Paper', 'Synthetics & Foam', 'Signs & Decals'],
  'Imperfections & Overlays': ['Scratches & Smudges', 'Dirt & Dust', 'Fingerprints', 'Decals & Stains'],
  Other: ['General', 'Patterns & Grids', 'Abstract', 'Misc'],
};

const TEXTURE_CATEGORIES = new Set(Object.keys(TEXTURE_TAXONOMY));

// PBR map channel matching rules
const PBR_CHANNEL_RULES = [
  // Albedo / Diffuse
  [['basecolor', 'base_color', 'albedo', 'diffuse', 'col', 'color', 'diff', '_d', '-d', 'diffuse_color'], 'Texture:Albedo'],
  // Normal
  [['normalgl', 'normaldx', 'normal_gl', 'normal_dx', 'normal', 'nor', 'norm', 'nrm', '_n', '-n'], 'Texture:Normal'],
  // Roughness
  [['roughness', 'rough', 'rgh', '_r', '-r'], 'Texture:Roughness'],
  // Glossiness (can fallback or map to Roughness)
  [['glossiness', 'gloss', '_g', '-g'], 'Texture:Roughness'],
  // Metallic
  [['metalness', 'metallic', 'metal', 'met', '_m', '-m'], 'Texture:Metallic'],
  // Ambient Occlusion
  [['ambientocclusion', 'ambient_occlusion', 'occlusion', 'ao', '_occ', '-occ'], 'Texture:AO'],
  // Height / Displacement
  [['displacement', 'height', 'disp', 'depth', '_h', '-h', 'bump_height'], 'Texture:Height'],
  // Specular
  [['specular', 'spec', '_s', '-s'], 'Texture:Specular'],
  // Emissive
  [['emissive', 'emission', 'emit', '_e', '-e'], 'Texture:Emissive'],
  // Opacity / Alpha / Mask
  [['opacity', 'alpha', 'mask', 'transparency'], 'Texture:Opacity'],
  // Bump
  [['bump'], 'Texture:Bump'],
];

// General categorization keyword rules (evaluated in order)
const KEYWORD_RULES = [
  // Roofing
  [['roofing', 'roof_tile', 'shingle', 'thatch', 'slate_roof', 'clay_roof', 'roof'], 'Roofing', 'Clay Shingles'],
  [['metal_roof'], 'Roofing', 'Metal Roofing'],

  // Electronics & Sci-Fi
  [['chip', 'microchip', 'circuit', 'pcb', 'motherboard', 'cpu', 'integrated_circuit'], 'Electronics', 'Circuit Boards & Chips'],
  [['solar_panel', 'solarpanel', 'solar', 'display', 'screen', 'monitor', 'led_panel'], 'Electronics', 'Panels & Displays'],
  [['wire', 'cable', 'fiber_optic'], 'Electronics', 'Wires & Cables'],

  // Food & Kitchen
  [['pizza', 'bread', 'pastry', 'baked', 'flour'], 'Food', 'Cooked & Baked'],
  [['candy', 'sweet', 'chocolate', 'cookie'], 'Food', 'Sweets & Candy'],
  [['fruit', 'vegetable', 'apple', 'orange'], 'Food', 'Fruits & Vegetables'],

  // Fabric & Leather
  [['leather', 'suede', 'hide'], 'Fabric & Leather', 'Leather'],
  [['denim', 'canvas', 'jeans'], 'Fabric & Leather', 'Denim & Canvas'],
  [['checkered', 'jacquard', 'gingham', 'floral', 'geometric_fabric'], 'Fabric & Leather', 'Patterns'],
  [['fabric', 'cloth', 'woven', 'cotton', 'linen', 'wool', 'textile', 'carpet', 'curtain', 'fleece', 'teddy', 'velour', 'velvet', 'satin', 'poplin', 'melange', 'jersey', 'tatami', 'wicker', 'caban', 'hessian', 'terlenka', 'georgette', 'corduroy', 'net', 'rope'], 'Fabric & Leather', 'Woven & Cloth'],

  // Imperfections & Overlays
  [['fingerprint', 'fingerprints'], 'Imperfections & Overlays', 'Fingerprints'],
  [['scratch', 'scratches', 'smudge', 'smudges', 'surfaceimperfection', 'wipe', 'rub'], 'Imperfections & Overlays', 'Scratches & Smudges'],
  [['dust', 'dirt_overlay', 'grunge', 'smear'], 'Imperfections & Overlays', 'Dirt & Dust'],
  [['decal', 'decals', 'stain', 'leak', 'footstep', 'puddle'], 'Imperfections & Overlays', 'Decals & Stains'],

  // Man-made (evaluated before Wood so Cardboard/Paper/Foam/Signs win over generic wood/board)
  [['cardboard', 'chipboard', 'paper', 'wallpaper'], 'Man-made', 'Cardboard & Paper'],
  [['asphalt', 'road', 'tarmac', 'highway'], 'Man-made', 'Asphalt'],
  [['glass', 'window_glass', 'stained_glass'], 'Man-made', 'Glass'],
  [['foam', 'acoustic_foam', 'acousticfoam', 'styrofoam', 'sponge'], 'Man-made', 'Synthetics & Foam'],
  [['sign', 'signage', 'sticker', 'tape', 'payment_card', 'paymentcard', 'credit_card'], 'Man-made', 'Signs & Decals'],
  [['plastic', 'rubber', 'polystyrene'], 'Man-made', 'Plastic & Rubber'],

  // Wood
  [['veneer', 'polished_wood', 'lacquered'], 'Wood', 'Polished & Finished'],
  [['bark', 'tree_bark', 'treeend', 'log', 'bamboo', 'cork'], 'Wood', 'Bark & Natural'],
  [['plank', 'board', 'timber', 'parquet', 'hardwood', 'wood_floor', 'woodfloor', 'plywood', 'siding', 'wood_siding', 'wood'], 'Wood', 'Planks & Boards'],

  // Metal
  [['rust', 'rusted', 'corroded', 'corrosion', 'oxidation'], 'Metal', 'Rusted & Corroded'],
  [['grate', 'grille', 'mesh_metal', 'wire_mesh', 'chainmail', 'fence', 'diamond_plate', 'diamondplate', 'rails'], 'Metal', 'Grates & Panels'],
  [['painted_metal', 'metal_painted'], 'Metal', 'Painted'],
  [['metal', 'steel', 'iron', 'bronze', 'copper', 'gold', 'brass', 'aluminum', 'chrome', 'foil', 'pipe', 'corrugated_steel', 'corrugatedsteel', 'sheet_metal', 'metalplates', 'metalwalkway'], 'Metal', 'Clean & Polished'],

  // Concrete & Plaster
  [['plaster', 'stucco', 'painted_wall', 'facade', 'interior_wall', 'wall_cladding', 'ceiling', 'officeceiling', 'wall'], 'Concrete & Plaster', 'Stucco & Plaster'],
  [['concrete', 'cement'], 'Concrete & Plaster', 'Smooth Concrete'],

  // Brick
  [['paver_brick', 'brick_paver'], 'Brick', 'Pavers'],
  [['brick', 'brickwall', 'masonry'], 'Brick', 'Standard Brick'],

  // Tiles & Paving
  [['mosaic'], 'Tiles & Paving', 'Mosaic'],
  [['subway'], 'Tiles & Paving', 'Subway Tiles'],
  [['paving_stone', 'pavingstone', 'pavement', 'tactile_paving', 'tactilepaving', 'flagstone', 'pathway', 'stone_paver', 'floor_pavement', 'herringbone_pavement', 'paving'], 'Tiles & Paving', 'Stone Pavers'],
  [['tile', 'tiles', 'ceramic', 'terrazzo', 'glazed_terracotta', 'glazedterracotta', 'porcelain', 'linoleum', 'laminate', 'klinkers', 'floor_pattern', 'square_floor'], 'Tiles & Paving', 'Ceramic Tiles'],

  // Ground & Terrain
  [['snow', 'ice', 'frost', 'glacier'], 'Ground & Terrain', 'Snow & Ice'],
  [['sand', 'dune', 'desert'], 'Ground & Terrain', 'Sand'],
  [['grass', 'mud', 'meadow', 'lawn', 'field', 'moss', 'forest_ground', 'leaves', 'flower', 'stickset', 'leaf', 'mulch'], 'Ground & Terrain', 'Grass & Mud'],
  [['dirt', 'soil', 'earth', 'ground', 'terrain', 'lava', 'riverbed', 'trail', 'rubble', 'beach'], 'Ground & Terrain', 'Dirt & Soil'],

  // Stone & Rock
  [['cobble', 'cobblestone'], 'Stone & Rock', 'Cobblestone'],
  [['pebble', 'gravel'], 'Stone & Rock', 'Pebbles & Gravel'],
  [['rock', 'stone', 'granite', 'marble', 'boulder', 'cliff', 'slate', 'travertine', 'onyx', 'limestone', 'sandstone', 'coral', 'shell', 'ivory', 'moon', 'quarry', 'ruins'], 'Stone & Rock', 'Natural Rock'],

  // Other / Prototyping
  [['prototype', 'grid', 'test_texture', 'checkerboard', 'uv_grid', 'pattern'], 'Other', 'Patterns & Grids'],
];

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ktx2': return 'image/ktx2';
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.tga': return 'image/x-tga';
    case '.tif':
    case '.tiff': return 'image/tiff';
    case '.exr': return 'image/x-exr';
    case '.bmp': return 'image/bmp';
    default: return 'application/octet-stream';
  }
}

function inferPbrRole(fileName) {
  const stem = path.basename(fileName, path.extname(fileName)).toLowerCase();
  const tokens = stem.split(/[_\-\s\.]+/).filter(Boolean);

  for (const [keywords, role] of PBR_CHANNEL_RULES) {
    for (const kw of keywords) {
      const kwLower = kw.toLowerCase();
      if (tokens.includes(kwLower) || stem.endsWith(`_${kwLower}`) || stem.endsWith(`-${kwLower}`) || stem === kwLower) {
        return role;
      }
    }
  }

  // Common suffix checks (e.g. filename_col, filename_nor, filename_rgh, filename_met, filename_ao)
  if (stem.endsWith('_col') || stem.endsWith('_diff') || stem.endsWith('_alb') || stem.endsWith('_color')) return 'Texture:Albedo';
  if (stem.endsWith('_nor') || stem.endsWith('_nrm') || stem.endsWith('_norm')) return 'Texture:Normal';
  if (stem.endsWith('_rgh') || stem.endsWith('_rough')) return 'Texture:Roughness';
  if (stem.endsWith('_met') || stem.endsWith('_metal')) return 'Texture:Metallic';
  if (stem.endsWith('_ao') || stem.endsWith('_occ')) return 'Texture:AO';
  if (stem.endsWith('_disp') || stem.endsWith('_height')) return 'Texture:Height';

  return 'Image';
}

function categorize(relPath, options = {}) {
  const normalized = relPath.toLowerCase().replace(/\\/g, '/');
  const rawBaseName = path.basename(relPath, path.extname(relPath));
  const allowedCategories = options.allowed_categories ? new Set(options.allowed_categories) : null;

  // 1. Explicit regex rules from pack.json "generation.category_rules"
  if (Array.isArray(options.category_rules)) {
    for (const rule of options.category_rules) {
      const [pattern, category, subcategory] = rule;
      if (new RegExp(pattern, 'i').test(normalized) && TEXTURE_CATEGORIES.has(category)) {
        if (!allowedCategories || allowedCategories.has(category)) {
          const validSub = subcategory && TEXTURE_TAXONOMY[category]?.includes(subcategory) ? subcategory : undefined;
          return { category, subcategory: validSub };
        }
      }
    }
  }

  // 2. Keyword token matching with PascalCase / camelCase word expansion
  const expandedStem = rawBaseName
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]/g, ' ')
    .toLowerCase();
  const wordTokens = expandedStem.split(/\s+/).filter(Boolean);
  const cleanCompact = rawBaseName.toLowerCase().replace(/[^a-z0-9]/g, '');

  for (const [keywords, category, subcategory] of KEYWORD_RULES) {
    if (allowedCategories && !allowedCategories.has(category)) continue;
    for (const kw of keywords) {
      const kwLower = kw.toLowerCase();
      const kwCompact = kwLower.replace(/[^a-z0-9]/g, '');
      if (
        wordTokens.includes(kwLower) ||
        expandedStem.includes(kwLower) ||
        cleanCompact.startsWith(kwCompact) ||
        cleanCompact === kwCompact ||
        normalized.includes(`/${kwLower}`) ||
        normalized.includes(`_${kwLower}`)
      ) {
        return { category, subcategory };
      }
    }
  }

  // 3. Fallback to pack default category if explicitly configured
  if (options.category && TEXTURE_CATEGORIES.has(options.category)) {
    const validSub = options.subcategory && TEXTURE_TAXONOMY[options.category]?.includes(options.subcategory)
      ? options.subcategory
      : TEXTURE_TAXONOMY[options.category]?.[0];
    return { category: options.category, subcategory: validSub };
  }

  // 4. Standard default fallback is now Other > General
  return { category: 'Other', subcategory: 'General' };
}

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function humanize(name) {
  const stem = path.basename(name, path.extname(name));
  return stem
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((word) => (word === word.toUpperCase() && word.length <= 4 ? word : word[0].toUpperCase() + word.slice(1).toLowerCase()))
    .join(' ');
}

function getAllFiles(dir, fileList = []) {
  if (!existsSync(dir)) return fileList;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      getAllFiles(fullPath, fileList);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) {
        fileList.push(fullPath);
      }
    }
  }
  return fileList;
}

const packsDir = path.join(REPO, 'packs');
let packSlugs = existsSync(packsDir)
  ? readdirSync(packsDir)
      .filter((n) => existsSync(path.join(packsDir, n, 'pack.json')))
      .sort()
  : [];

if (targetPackSlug) {
  if (!packSlugs.includes(targetPackSlug)) {
    console.error(`Pack '${targetPackSlug}' not found under packs/`);
    process.exit(1);
  }
  packSlugs = [targetPackSlug];
}

const REQUIRED_PACK_KEYS = ['name', 'creator', 'website', 'license', 'description'];
const allPacks = [];

for (const slug of packSlugs) {
  const packRoot = path.join(packsDir, slug);
  const meta = JSON.parse(readFileSync(path.join(packRoot, 'pack.json'), 'utf8'));

  const missing = REQUIRED_PACK_KEYS.filter((k) => !meta[k]);
  if (missing.length) {
    console.error(`packs/${slug}/pack.json is missing: ${missing.join(', ')}`);
    process.exit(1);
  }

  const texturesDir = path.join(packRoot, 'textures');
  const searchDir = existsSync(texturesDir) ? texturesDir : packRoot;

  // Get pinned commit SHA for this pack
  let packSha;
  try {
    packSha = execSync(`git log -1 --format=%H -- packs/${slug}`, { cwd: REPO }).toString().trim();
  } catch {}
  if (!packSha) {
    try {
      packSha = execSync('git log -1 --format=%H', { cwd: REPO }).toString().trim();
    } catch {}
  }
  const rawBase = `https://raw.githubusercontent.com/${OWNER_REPO}/${packSha || 'main'}`;

  const files = [];
  const items = [];
  const previews = [];

  const asset = (relPath) => ({
    rel: relPath.replace(/\\/g, '/'),
    url: `${rawBase}/${relPath.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')}`,
    abs: path.join(REPO, relPath),
  });

  const coverPath = path.join(packRoot, 'cover.png');
  if (existsSync(coverPath)) {
    const cover = asset(path.relative(REPO, coverPath));
    previews.push({
      fileName: 'cover.png',
      path: cover.rel,
      externalUrl: cover.url,
      sha256: sha256(cover.abs),
      size: statSync(cover.abs).size,
      contentType: 'image/png',
      type: 'Thumbnail',
    });
  }

  const textureFiles = getAllFiles(searchDir);

  // Group files by texture set (by parent directory if nested, or by prefix if flat)
  const textureGroups = new Map();

  for (const filePath of textureFiles) {
    const fileName = path.basename(filePath);
    if (fileName === 'cover.png' || fileName === 'store-preview.png') continue;

    const relFromPack = path.relative(packRoot, filePath).replace(/\\/g, '/');
    const parts = relFromPack.split('/');

    let groupKey;
    if (parts.length > 2 && parts[0] === 'textures') {
      // Nested: textures/<set_name>/<file>
      groupKey = parts[1];
    } else {
      // Flat: extract base material name before PBR channel suffix
      const stem = path.basename(fileName, path.extname(fileName));
      const stripped = stem.replace(/([_\-\s]+(diffuse|albedo|basecolor|col|color|normal|nor|nrm|roughness|rough|rgh|metalness|metallic|metal|met|ao|ambientocclusion|displacement|height|disp|specular|spec|emissive|opacity|bump|glossiness|preview|thumb|thumbnail))+$/i, '');
      groupKey = stripped || stem;
    }

    if (!textureGroups.has(groupKey)) {
      textureGroups.set(groupKey, []);
    }
    textureGroups.get(groupKey).push(filePath);
  }

  for (const [groupKey, groupFiles] of textureGroups.entries()) {
    const groupItemFiles = [];
    const dn = humanize(groupKey);
    let previewFile = null;

    // Pick best preview file:
    // 1. Author 3D render preview (*_preview.png)
    // 2. Albedo / Color map
    // 3. Any non-normal/non-AO map
    for (const filePath of groupFiles) {
      const relFromRepo = path.relative(REPO, filePath).replace(/\\/g, '/');
      const fileName = path.basename(filePath);
      const ast = asset(relFromRepo);
      const role = inferPbrRole(fileName);

      const fileEntry = {
        fileName,
        path: ast.rel,
        externalUrl: ast.url,
        sha256: sha256(ast.abs),
        size: statSync(ast.abs).size,
        role,
      };
      files.push(fileEntry);
      groupItemFiles.push({ path: ast.rel, role });

      if (fileName.endsWith('_preview.png') || fileName === `${groupKey}.png` || fileName.toLowerCase() === 'preview.png') {
        previewFile = { filePath, ast, fileEntry };
      } else if (!previewFile && (role === 'Texture:Albedo' || (role !== 'Texture:Normal' && role !== 'Texture:AO'))) {
        previewFile = { filePath, ast, fileEntry };
      }
    }

    if (!previewFile && groupFiles.length > 0) {
      const firstPath = groupFiles[0];
      const relFromRepo = path.relative(REPO, firstPath).replace(/\\/g, '/');
      const ast = asset(relFromRepo);
      previewFile = {
        filePath: firstPath,
        ast,
        fileEntry: {
          fileName: path.basename(firstPath),
          sha256: sha256(ast.abs),
          size: statSync(ast.abs).size,
        },
      };
    }

    const sampleRel = path.relative(packRoot, groupFiles[0]).replace(/\\/g, '/');
    const { category, subcategory } = categorize(sampleRel, meta.generation || {});

    const upstream = meta.upstream || {};
    let sourceUrl = upstream.source_url || meta.website || null;
    let sourceDownloadUrl = upstream.download_url || meta.website || null;
    const availableResolutions = upstream.available_resolutions || null;
    const isKtx2 = groupFiles.some((f) => f.toLowerCase().endsWith('.ktx2'));

    if (meta.website?.includes('polyhaven.com') && groupKey) {
      sourceUrl = `https://polyhaven.com/a/${groupKey}`;
      sourceDownloadUrl = `https://polyhaven.com/a/${groupKey}`;
    } else if (meta.website?.includes('ambientcg.com') && groupKey) {
      sourceUrl = `https://ambientcg.com/view?id=${groupKey}`;
      sourceDownloadUrl = `https://ambientcg.com/view?id=${groupKey}`;
    }

    items.push({
      name: dn,
      itemType: 'TextureSet',
      metadataJson: JSON.stringify({
        category,
        ...(subcategory ? { subcategory } : {}),
        format: isKtx2 ? 'ktx2' : 'image',
        resolution: '512',
        ...(sourceUrl ? { sourceUrl } : {}),
        ...(sourceDownloadUrl ? { sourceDownloadUrl } : {}),
        ...(availableResolutions ? { availableResolutions } : {}),
      }),
      isPreviewable: true,
      files: groupItemFiles,
    });

    if (previewFile) {
      previews.push({
        fileName: previewFile.fileEntry.fileName,
        path: previewFile.ast.rel,
        externalUrl: previewFile.ast.url,
        sha256: previewFile.fileEntry.sha256,
        size: previewFile.fileEntry.size,
        contentType: getMimeType(previewFile.filePath),
        type: 'Thumbnail',
        itemName: dn,
      });
    }
  }

  const packManifest = {
    source: `https://github.com/${OWNER_REPO}`,
    license: meta.license || 'CC0',
    name: meta.name,
    creator: meta.creator,
    website: meta.website,
    description: meta.description,
    folder: `packs/${slug}`,
    pinnedSha: packSha || null,
    itemCount: items.length,
    items,
    files,
    previews,
  };

  const packManifestPath = path.join(packRoot, 'store-manifest.json');
  writeFileSync(packManifestPath, JSON.stringify(packManifest, null, 2) + '\n');

  allPacks.push(packManifest);

  const byCategory = new Map();
  for (const item of items) {
    const metaObj = JSON.parse(item.metadataJson);
    const cat = metaObj.subcategory ? `${metaObj.category} > ${metaObj.subcategory}` : metaObj.category;
    if (!byCategory.has(cat)) byCategory.set(cat, 0);
    byCategory.set(cat, byCategory.get(cat) + 1);
  }

  const bytes = files.reduce((a, f) => a + f.size, 0);
  const catSummary = Array.from(byCategory.entries())
    .map(([c, count]) => `${c}: ${count}`)
    .join(', ');

  console.log(
    `[${slug}] ${meta.name}: ${items.length} texture sets, ${files.length} files, ` +
    `${(bytes / 1024 / 1024).toFixed(2)} MB (${catSummary || 'no categories'}) ` +
    `(pinned: ${packSha ? packSha.slice(0, 8) : 'HEAD'})`
  );
}

if (writeRoot) {
  writeFileSync(
    path.join(REPO, 'store-manifest.json'),
    JSON.stringify({ source: `https://github.com/${OWNER_REPO}`, license: 'CC0', packs: allPacks }, null, 2) + '\n'
  );
  console.log(`\nwrote root store-manifest.json (${allPacks.length} pack(s))`);
}
