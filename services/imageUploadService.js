const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const DEFAULT_MAX_BYTES = 500 * 1024;
const DEFAULT_MAX_DIMENSION = 1600;
const MIN_DIMENSION = 720;
const QUALITY_STEPS = [82, 76, 70, 64, 58, 52, 46, 40];

function ensureUploadDir(uploadDir) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

function normalizeUploadPrefix(prefix = 'image') {
  return String(prefix || 'image')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'image';
}

function validateImageUpload(file) {
  if (!file?.buffer || Number(file.size || 0) <= 0) {
    throw new Error('File gambar tidak ditemukan.');
  }
  const mime = String(file.mimetype || '').toLowerCase();
  if (!mime.startsWith('image/')) {
    throw new Error('File harus berupa gambar.');
  }
}

async function compressImageToTarget(file, options = {}) {
  validateImageUpload(file);
  const maxBytes = Math.max(64 * 1024, Number(options.maxBytes || DEFAULT_MAX_BYTES) || DEFAULT_MAX_BYTES);
  const baseImage = sharp(file.buffer, { failOn: 'none' }).rotate();
  const metadata = await baseImage.metadata();
  const originalWidth = Number(metadata.width || 0) || DEFAULT_MAX_DIMENSION;
  const originalHeight = Number(metadata.height || 0) || DEFAULT_MAX_DIMENSION;
  const maxOriginalDimension = Math.max(originalWidth, originalHeight, 1);
  let currentMaxDimension = Math.min(Number(options.maxDimension || DEFAULT_MAX_DIMENSION) || DEFAULT_MAX_DIMENSION, maxOriginalDimension);
  let bestBuffer = null;

  while (currentMaxDimension >= MIN_DIMENSION) {
    for (const quality of QUALITY_STEPS) {
      const rendered = await baseImage
        .resize({
          width: currentMaxDimension >= originalWidth ? null : currentMaxDimension,
          height: currentMaxDimension >= originalHeight ? null : currentMaxDimension,
          fit: 'inside',
          withoutEnlargement: true
        })
        .webp({ quality, effort: 4 })
        .toBuffer();

      if (!bestBuffer || rendered.length < bestBuffer.length) {
        bestBuffer = rendered;
      }
      if (rendered.length <= maxBytes) {
        return {
          buffer: rendered,
          ext: 'webp',
          mimeType: 'image/webp',
          size: rendered.length
        };
      }
    }

    if (currentMaxDimension === MIN_DIMENSION) break;
    currentMaxDimension = Math.max(MIN_DIMENSION, Math.floor(currentMaxDimension * 0.84));
  }

  if (bestBuffer && bestBuffer.length <= maxBytes) {
    return {
      buffer: bestBuffer,
      ext: 'webp',
      mimeType: 'image/webp',
      size: bestBuffer.length
    };
  }

  throw new Error('Gambar terlalu besar. Gunakan foto yang lebih ringan atau resolusi lebih kecil.');
}

async function persistCompressedImageUpload(file, prefix, options = {}) {
  const uploadDir = options.uploadDir
    ? path.resolve(options.uploadDir)
    : path.join(__dirname, '..', 'public', 'uploads');
  ensureUploadDir(uploadDir);
  const optimized = await compressImageToTarget(file, options);
  const safePrefix = normalizeUploadPrefix(prefix);
  const filename = `${safePrefix}-${Date.now()}.${optimized.ext}`;
  const filePath = path.join(uploadDir, filename);
  fs.writeFileSync(filePath, optimized.buffer);
  return {
    publicUrl: `/uploads/${filename}`,
    filePath,
    size: optimized.size,
    mimeType: optimized.mimeType
  };
}

module.exports = {
  DEFAULT_MAX_BYTES,
  compressImageToTarget,
  persistCompressedImageUpload
};
