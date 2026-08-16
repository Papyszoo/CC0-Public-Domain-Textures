# CC0-Public-Domain-Textures

A curated collection of **100% CC0 Public Domain Textures, PBR Materials, Seamless Patterns, and Surface Maps** for game developers, 3D artists, and creators.

Every texture set in this repository is organized with verified provenance, standardized PBR map channels (Albedo, Normal, Roughness, Metallic, Height/Displacement, Ambient Occlusion), and metadata tags ready for modern game engines and DCC tools.

[![Browse Textures on ModelibrStore](docs/store-preview.png)](https://store.modelibr.com)

---

## Live Catalog & One-Click Import

All texture packs in this repository are indexed and hosted on **[store.modelibr.com](https://store.modelibr.com)**:

- **Ultra-Lightweight Max 512px KTX2 Format**: All texture maps are standardized to max 512px (512x512) GPU-compressed **KTX2 (Basis Universal / UASTC with RDO)** files with full mipmaps for instant loading, zero lag during 3D scene generation, and minimal repository size (~40–80 KB per texture map).
- **Upstream High-Resolution Links**: Each pack preserves the direct download and source page links for users who want to download 1K, 2K, 4K, or 8K uncompressed master maps directly from the original creators.
- **Interactive Material & Texture Browsing**: Inspect PBR texture channels, material properties, and seamless tiling directly in your browser.
- **One-Click Local Import**: Import packs and individual texture sets directly into your local **[Modelibr](https://github.com/Papyszoo/Modelibr)** desktop instance.
- **Standardized Texture Taxonomy**: Categorized across 12 standardized material domains:
  - `Wood`, `Metal`, `Stone & Rock`, `Brick`, `Concrete & Plaster`, `Ground & Terrain`
  - `Fabric & Leather`, `Tiles & Paving`, `Roofing`, `Organic`, `Man-made`, `Imperfections & Overlays`

---

## Included Collections

| Creator / Collection | Description |
| :--- | :--- |
| **[Poly Haven](https://polyhaven.com)** | High-fidelity photorealistic PBR texture sets (Wood, Rock, Concrete, Metal, Ground, Tiles, Plaster) with links to 8K/16K masters. |
| **[AmbientCG](https://ambientcg.com)** | Comprehensive procedural and photogrammetry public domain PBR material sets with links to 4K/8K masters. |
| **[Kenney](https://kenney.nl)** | Stylized and prototype texture kits for game development and level blockouts. |
| **Community Textures** | Verified CC0 surface materials, seamless patterns, terrain layers, and decals. |

---

## Repository Layout

Every texture pack is completely self-contained in its own directory:

```text
packs/
  <pack-slug>/
    pack.json              # Authored metadata (name, creator, website, upstream links, license, description)
    cover.png              # Pack cover art / catalog listing thumbnail (optional/original author)
    store-manifest.json    # Self-contained store manifest pinned to Git commit
    textures/              # Max 512px KTX2 PBR texture maps (.ktx2) + catalog preview PNGs
scripts/
  convert-to-ktx2.mjs           # Batch resizes & converts textures to max 512px KTX2 (UASTC+RDO)
  fetch-polyhaven-textures.mjs  # Ingests Poly Haven PBR materials into packs/polyhaven-textures/
  fetch-ambientcg-textures.mjs  # Ingests AmbientCG PBR materials into packs/ambientcg-textures/
  fetch-kenney-textures.mjs     # Ingests Kenney texture kits into packs/kenney-<slug>/
  generate-store-manifest.mjs   # Generates per-pack store-manifest.json
```

---

## License

All assets in this repository are dedicated to the public domain under the **[Creative Commons Zero 1.0 Universal (CC0 1.0)](https://creativecommons.org/publicdomain/zero/1.0/)** license. You may freely use, modify, distribute, and monetize these assets in personal and commercial projects without attribution.
