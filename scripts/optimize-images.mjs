import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const publicDir = path.resolve('public');
const exts = new Set(['.jpg', '.jpeg']);

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(fullPath)));
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (exts.has(ext)) files.push(fullPath);
  }

  return files;
}

async function main() {
  const files = await walk(publicDir);
  let converted = 0;

  for (const filePath of files) {
    const outputPath = filePath.replace(/\.(jpe?g)$/i, '.webp');

    await sharp(filePath)
      .rotate()
      .webp({ quality: 82, effort: 5 })
      .toFile(outputPath);

    const [sourceStat, targetStat] = await Promise.all([stat(filePath), stat(outputPath)]);
    const saved = sourceStat.size - targetStat.size;

    console.log(`${path.basename(filePath)} -> ${path.basename(outputPath)} | ${(sourceStat.size / 1024).toFixed(1)}KB -> ${(targetStat.size / 1024).toFixed(1)}KB | ahorro ${(saved / 1024).toFixed(1)}KB`);
    converted += 1;
  }

  console.log(`\nTotal convertidas: ${converted}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
