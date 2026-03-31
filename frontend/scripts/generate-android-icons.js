/**
 * Regenerates Android launcher icon files from the source PNGs defined in app.json.
 * Run: node scripts/generate-android-icons.js
 */
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');

// Source images
const ICON_SRC       = path.join(ROOT, 'assets', 'icons', 'SportConnect_icon.png');
const ADAPTIVE_SRC   = path.join(ROOT, 'assets', 'icons', 'SportConnect_adaptive.png');

// Android icon density sizes (dp → px at each bucket)
// Legacy icon: 48dp base
const LEGACY_SIZES = {
  'mipmap-mdpi':    48,
  'mipmap-hdpi':    72,
  'mipmap-xhdpi':   96,
  'mipmap-xxhdpi':  144,
  'mipmap-xxxhdpi': 192,
};

// Adaptive foreground: 108dp base (safe zone is 72dp centred within 108dp)
const ADAPTIVE_SIZES = {
  'mipmap-mdpi':    108,
  'mipmap-hdpi':    162,
  'mipmap-xhdpi':   216,
  'mipmap-xxhdpi':  324,
  'mipmap-xxxhdpi': 432,
};

async function resizeToWebp(src, dest, size) {
  await sharp(src)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 90 })
    .toFile(dest);
  console.log(`  ✓ ${path.relative(ROOT, dest)} (${size}x${size})`);
}

async function main() {
  // 1. Generate legacy ic_launcher.webp and ic_launcher_round.webp
  console.log('\n[1/3] Generating legacy launcher icons...');
  for (const [folder, size] of Object.entries(LEGACY_SIZES)) {
    const dir = path.join(RES, folder);
    fs.mkdirSync(dir, { recursive: true });
    await resizeToWebp(ICON_SRC, path.join(dir, 'ic_launcher.webp'), size);
    await resizeToWebp(ICON_SRC, path.join(dir, 'ic_launcher_round.webp'), size);
  }

  // 2. Generate adaptive foreground ic_launcher_foreground.webp
  console.log('\n[2/3] Generating adaptive foreground icons...');
  for (const [folder, size] of Object.entries(ADAPTIVE_SIZES)) {
    const dir = path.join(RES, folder);
    fs.mkdirSync(dir, { recursive: true });
    await resizeToWebp(ADAPTIVE_SRC, path.join(dir, 'ic_launcher_foreground.webp'), size);
  }

  // 3. Create mipmap-anydpi-v26 XML descriptors
  console.log('\n[3/3] Writing adaptive icon XML descriptors...');
  const anydpiDir = path.join(RES, 'mipmap-anydpi-v26');
  fs.mkdirSync(anydpiDir, { recursive: true });

  const adaptiveXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@color/ic_launcher_background"/>
  <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`;
  fs.writeFileSync(path.join(anydpiDir, 'ic_launcher.xml'), adaptiveXml);
  fs.writeFileSync(path.join(anydpiDir, 'ic_launcher_round.xml'), adaptiveXml);
  console.log('  ✓ mipmap-anydpi-v26/ic_launcher.xml');
  console.log('  ✓ mipmap-anydpi-v26/ic_launcher_round.xml');

  // 4. Ensure ic_launcher_background color is defined in values/colors.xml
  const colorsPath = path.join(RES, 'values', 'colors.xml');
  let colorsXml = fs.existsSync(colorsPath) ? fs.readFileSync(colorsPath, 'utf8') : '';
  if (!colorsXml.includes('ic_launcher_background')) {
    // Add before </resources>
    colorsXml = colorsXml.replace(
      '</resources>',
      '  <color name="ic_launcher_background">#FFFFFF</color>\n</resources>'
    );
    fs.writeFileSync(colorsPath, colorsXml);
    console.log('  ✓ Added ic_launcher_background color to values/colors.xml');
  } else {
    console.log('  ✓ ic_launcher_background color already present');
  }

  console.log('\nDone! Commit the android/ changes and do a fresh EAS build.');
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
