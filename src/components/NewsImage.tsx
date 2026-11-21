import { useCallback, useEffect, useRef, useState } from 'react';
import { Newspaper } from 'lucide-react';
import {
  drawCircularLogoWatermark,
  getCachedCircleLogoImage,
  loadCircleLogoImage,
} from '../utils/watermark';

interface NewsImageProps {
  src?: string;
  alt: string;
  className?: string;
  aspectClass?: string;
  showWatermark?: boolean;
  watermarkApplied?: boolean;
  fillParent?: boolean;
}

export function NewsImage({
  src,
  alt,
  className = '',
  aspectClass = 'aspect-[4/3]',
  watermarkApplied = false,
  fillParent = false,
}: NewsImageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const loadedImageRef = useRef<HTMLImageElement | null>(null);
  const logoImageRef = useRef<HTMLImageElement | null>(getCachedCircleLogoImage());
  const [status, setStatus] = useState<'idle' | 'loading' | 'loaded' | 'error'>(
    src ? 'loading' : 'idle'
  );

  const drawCanvas = useCallback(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const img = loadedImageRef.current;
    if (!container || !canvas || !img || !img.naturalWidth || !img.naturalHeight) return;

    const rect = container.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (width <= 0 || height <= 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.round(width * dpr);
    const targetH = Math.round(height * dpr);

    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // Object-fit cover math: when a photo already has its circular top-left watermark baked,
    // pin top-left inside overflow so aspect-ratio cropping never slices the baked logo off.
    const scale = Math.max(width / img.naturalWidth, height / img.naturalHeight);
    const drawW = img.naturalWidth * scale;
    const drawH = img.naturalHeight * scale;
    const offsetX = watermarkApplied && drawW > width ? 0 : (width - drawW) / 2;
    const offsetY = watermarkApplied && drawH > height ? 0 : (height - drawH) / 2;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, offsetX, offsetY, drawW, drawH);

    // Apply circular CoffeeNadu logo watermark at TOP-LEFT if not already baked into the image
    if (!watermarkApplied && logoImageRef.current) {
      drawCircularLogoWatermark(ctx, width, height, logoImageRef.current);
    }
  }, [watermarkApplied]);

  useEffect(() => {
    let active = true;
    if (!logoImageRef.current) {
      void loadCircleLogoImage().then((logoImg) => {
        if (!active || !logoImg) return;
        logoImageRef.current = logoImg;
        if (loadedImageRef.current) {
          drawCanvas();
        }
      });
    }
    return () => {
      active = false;
    };
  }, [drawCanvas]);

  useEffect(() => {
    // Immediately clear stale canvas pixels & image ref on src change to prevent brief image flashes
    loadedImageRef.current = null;
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }

    if (!src) {
      setStatus('idle');
      return;
    }

    let cancelled = false;
    setStatus('loading');
    const img = new Image();
    img.referrerPolicy = 'no-referrer';

    img.onload = () => {
      if (cancelled) return;
      loadedImageRef.current = img;
      setStatus('loaded');
      window.requestAnimationFrame(() => {
        if (!cancelled) drawCanvas();
      });
    };

    img.onerror = () => {
      if (cancelled) return;
      loadedImageRef.current = null;
      setStatus('error');
    };

    img.src = src;

    return () => {
      cancelled = true;
      img.onload = null;
      img.onerror = null;
    };
  }, [src, drawCanvas]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      if (loadedImageRef.current) {
        drawCanvas();
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [drawCanvas]);

  const wrapperLayoutClass = fillParent
    ? 'absolute inset-0 w-full h-full'
    : `relative ${aspectClass} w-full`;

  if (!src || status === 'error') {
    return (
      <div
        className={`${wrapperLayoutClass} bg-stone-100 border border-stone-200 flex flex-col items-center justify-center p-4 text-center select-none ${className}`}
        aria-label={alt}
        onContextMenu={(e) => e.preventDefault()}
        onDragStart={(e) => e.preventDefault()}
      >
        <Newspaper className="w-6 h-6 text-stone-400 mb-2" aria-hidden="true" />
        <span className="text-xs font-medium text-stone-500 line-clamp-2 max-w-[220px] font-kannada">
          {alt}
        </span>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={alt}
      className={`${wrapperLayoutClass} isolate overflow-hidden bg-stone-200 select-none ${className}`}
      onContextMenu={(e) => e.preventDefault()}
      onDragStart={(e) => e.preventDefault()}
    >
      {status === 'loading' && (
        <div
          aria-hidden="true"
          className="absolute inset-0 z-20 bg-stone-200 animate-pulse"
        />
      )}

      {/* Protected Canvas Renderer: no <img> tag in DOM, blocking Save/Download/Open Image menus */}
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        onContextMenu={(e) => e.preventDefault()}
        onDragStart={(e) => e.preventDefault()}
        className="w-full h-full block pointer-events-none select-none transition-transform duration-300 ease-out group-hover:scale-[1.02]"
      />

      {/* Transparent protective overlay intercepts long-press & right-click */}
      <div
        aria-hidden="true"
        onContextMenu={(e) => e.preventDefault()}
        onDragStart={(e) => e.preventDefault()}
        className="absolute inset-0 z-10 select-none bg-transparent"
      />
    </div>
  );
}
