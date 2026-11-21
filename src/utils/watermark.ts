import coffeenaduCircleLogoUrl from '../assets/images/coffeenadu_logo_circle.png';

let cachedCircleLogo: HTMLImageElement | null = null;
let loadingPromise: Promise<HTMLImageElement | null> | null = null;

/**
 * Loads the pre-cropped circular transparent CoffeeNadu logo PNG once and caches it.
 */
export function loadCircleLogoImage(): Promise<HTMLImageElement | null> {
  if (typeof window === 'undefined' || typeof Image === 'undefined') {
    return Promise.resolve(null);
  }
  if (cachedCircleLogo && cachedCircleLogo.complete && cachedCircleLogo.naturalWidth > 0) {
    return Promise.resolve(cachedCircleLogo);
  }
  if (loadingPromise) {
    return loadingPromise;
  }

  loadingPromise = new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.onload = () => {
      cachedCircleLogo = img;
      resolve(img);
    };
    img.onerror = () => {
      loadingPromise = null;
      resolve(null);
    };
    img.src = coffeenaduCircleLogoUrl;
  });

  return loadingPromise;
}

export function getCachedCircleLogoImage(): HTMLImageElement | null {
  if (cachedCircleLogo && cachedCircleLogo.complete && cachedCircleLogo.naturalWidth > 0) {
    return cachedCircleLogo;
  }
  return null;
}

// Start preloading on client startup so logos render immediately on first paint
if (typeof window !== 'undefined') {
  void loadCircleLogoImage();
}

/**
 * Computes consistent medium size and top-left edge padding proportional to image/canvas size.
 */
export function computeCircularWatermarkMetrics(width: number, height: number): {
  size: number;
  pad: number;
} {
  const minDim = Math.max(1, Math.min(width, height));
  // Small card thumbnails (~80-130px) need ~25% to remain clearly visible;
  // medium/full photos use ~14.5% (capped cleanly so it never covers key subject matter).
  const size =
    minDim <= 140
      ? Math.max(20, Math.min(36, Math.round(minDim * 0.26)))
      : Math.max(36, Math.min(112, Math.round(minDim * 0.145)));

  const pad =
    minDim <= 140
      ? Math.max(5, Math.round(minDim * 0.06))
      : Math.max(10, Math.round(minDim * 0.032));

  return { size, pad };
}

/**
 * Draws ONLY the circular CoffeeNadu logo at the TOP-LEFT corner with crisp edge clipping
 * and subtle elevation shadow so there are never square corners or extra text/borders.
 */
export function drawCircularLogoWatermark(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  logoImg: HTMLImageElement | null = getCachedCircleLogoImage()
): boolean {
  if (!logoImg || !logoImg.naturalWidth || width <= 0 || height <= 0) {
    return false;
  }

  const { size, pad } = computeCircularWatermarkMetrics(width, height);
  const cx = pad + size / 2;
  const cy = pad + size / 2;
  const r = size / 2;

  ctx.save();
  // Subtle circular drop-shadow around the gold rim for contrast against bright skies/walls
  ctx.shadowColor = 'rgba(0, 0, 0, 0.34)';
  ctx.shadowBlur = Math.max(3, Math.round(size * 0.1));
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(1, r - 0.5), 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(logoImg, pad, pad, size, size);
  ctx.restore();

  return true;
}

const MAX_FIRESTORE_IMAGE_CHARS = 320000;

/**
 * Takes an existing photo source (data URL or image URL), preserves aspect ratio and quality,
 * applies the circular CoffeeNadu logo watermark once at the top-left corner, and outputs a
 * Firestore-safe JPEG data URL. Never modifies original files on disk.
 */
export async function applyWatermarkToImageSrc(imageSrc: string): Promise<string> {
  const logoImg = await loadCircleLogoImage();

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.crossOrigin = 'anonymous';
    el.referrerPolicy = 'no-referrer';
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Unable to load image for watermarking.'));
    el.src = imageSrc;
  });

  const naturalWidth = Math.max(1, img.naturalWidth || img.width);
  const naturalHeight = Math.max(1, img.naturalHeight || img.height);
  const longest = Math.max(naturalWidth, naturalHeight);

  const attempts = [
    { maxDim: Math.min(960, longest), quality: 0.82 },
    { maxDim: 800, quality: 0.72 },
    { maxDim: 640, quality: 0.6 },
    { maxDim: 520, quality: 0.5 },
  ];

  for (const attempt of attempts) {
    const scale = longest > attempt.maxDim ? attempt.maxDim / longest : 1;
    const targetW = Math.max(1, Math.round(naturalWidth * scale));
    const targetH = Math.max(1, Math.round(naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not initialize canvas for watermarking.');
    }

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetW, targetH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, targetW, targetH);

    if (logoImg) {
      drawCircularLogoWatermark(ctx, targetW, targetH, logoImg);
    }

    const jpegUrl = canvas.toDataURL('image/jpeg', attempt.quality);
    if (jpegUrl.length <= MAX_FIRESTORE_IMAGE_CHARS) {
      return jpegUrl;
    }
  }

  throw new Error('Watermarked photo exceeded maximum size limit.');
}
