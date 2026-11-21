import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { ImagePlus, Link2, Loader2, Trash2, X } from 'lucide-react';
import {
  IMAGE_PRESETS,
  KOPPA_LOCATIONS,
  NEWS_CATEGORIES,
  getKannadaLocationLabel,
  resolveArticleImage,
} from '../data/newsData';
import type { ImageKey, NewsArticle, NewsCategory } from '../types/news';
import {
  buildArticlePublicUrl,
  formatCustomEnglishSlug,
  validateCustomEnglishSlugInput,
} from '../utils/slug';
import {
  editorHtmlToParagraphs,
  fieldValueToEditorHtml,
  paragraphsToEditorHtml,
  sanitizeInlineRichTextHtml,
  stripRichTextToPlainText,
} from '../utils/richText';
import {
  applyWatermarkToImageSrc,
  drawCircularLogoWatermark,
  loadCircleLogoImage,
} from '../utils/watermark';
import {
  isSheetsStorageActive,
  uploadImageToDriveViaServer,
} from '../services/sheetsStorageClient';
import { NewsImage } from './NewsImage';
import { RichTextField, RichTextToolbar, useRichTextController } from './RichTextEditor';

export interface AdminArticlePayload {
  customSlug?: string;
  titleKannada: string;
  summaryKannada: string;
  bodyKannada: string[];
  category: NewsCategory;
  location: string;
  reporter: string;
  imageKey: ImageKey;
  imageUrl?: string;
  imageThumbUrl?: string;
  imageDriveId?: string;
  imageCaption?: string;
  isFeatured: boolean;
  watermarkApplied?: boolean;
  alsoAddToProgram?: boolean;
  programDate?: string;
  programTime?: string;
  programOrganizer?: string;
}

function getTodayYmd(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

interface AdminArticleModalProps {
  isOpen: boolean;
  editingArticle: NewsArticle | null;
  existingArticleIds?: string[];
  isSaving: boolean;
  onClose: () => void;
  onSubmit: (payload: AdminArticlePayload) => Promise<void>;
}

const MAX_FIRESTORE_IMAGE_CHARS = 320000;

export function isLikelyImageFile(file: File): boolean {
  if (file.type && file.type.startsWith('image/')) return true;
  return /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(file.name || '');
}

async function loadImageSource(file: File): Promise<{
  width: number;
  height: number;
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
  cleanup: () => void;
}> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        width: bitmap.width,
        height: bitmap.height,
        draw: (ctx, w, h) => ctx.drawImage(bitmap, 0, 0, w, h),
        cleanup: () => bitmap.close(),
      };
    } catch {
      // Fallback to HTMLImageElement + ObjectURL below
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('This image format could not be decoded by the browser.'));
      el.src = objectUrl;
    });
    return {
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      draw: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h),
      cleanup: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (err) {
    URL.revokeObjectURL(objectUrl);
    throw err;
  }
}

export async function compressImageForFirestore(file: File): Promise<string> {
  const [source, logoImg] = await Promise.all([
    loadImageSource(file),
    loadCircleLogoImage(),
  ]);
  try {
    const attempts: { maxDim: number; quality: number }[] = [
      { maxDim: 960, quality: 0.78 },
      { maxDim: 800, quality: 0.68 },
      { maxDim: 640, quality: 0.58 },
      { maxDim: 520, quality: 0.48 },
    ];

    for (const attempt of attempts) {
      const longest = Math.max(source.width, source.height, 1);
      const scale = longest > attempt.maxDim ? attempt.maxDim / longest : 1;
      const targetWidth = Math.max(1, Math.round(source.width * scale));
      const targetHeight = Math.max(1, Math.round(source.height * scale));

      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Could not initialize image compressor in this browser.');
      }

      // Fill white background so transparent PNGs convert cleanly to JPEG
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, targetWidth, targetHeight);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      source.draw(ctx, targetWidth, targetHeight);

      // Automatically bake circular CoffeeNadu logo watermark at TOP-LEFT once per uploaded photo
      if (logoImg) {
        drawCircularLogoWatermark(ctx, targetWidth, targetHeight, logoImg);
      }

      const jpegUrl = canvas.toDataURL('image/jpeg', attempt.quality);
      if (jpegUrl.length <= MAX_FIRESTORE_IMAGE_CHARS) {
        return jpegUrl;
      }
    }

    throw new Error(
      'Photo is still too large after compression. Please pick a smaller image or crop it first.'
    );
  } finally {
    source.cleanup();
  }
}

export async function processAndUploadNewsPhoto(file: File): Promise<{
  imageUrl: string;
  imageThumbUrl?: string;
  imageDriveId?: string;
  uploadedToDrive: boolean;
  deduplicated?: boolean;
}> {
  const [source, logoImg] = await Promise.all([
    loadImageSource(file),
    loadCircleLogoImage(),
  ]);

  let fullDataUrl = '';
  let thumbDataUrl = '';

  try {
    const renderVariant = (maxDim: number, quality: number) => {
      const longest = Math.max(source.width, source.height, 1);
      const scale = longest > maxDim ? maxDim / longest : 1;
      const targetWidth = Math.max(1, Math.round(source.width * scale));
      const targetHeight = Math.max(1, Math.round(source.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Could not initialize image compressor in this browser.');
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, targetWidth, targetHeight);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      source.draw(ctx, targetWidth, targetHeight);
      if (logoImg) {
        drawCircularLogoWatermark(ctx, targetWidth, targetHeight, logoImg);
      }
      return canvas.toDataURL('image/jpeg', quality);
    };

    const sheetsActive = await isSheetsStorageActive();
    if (sheetsActive) {
      // High-quality compressed image + lightweight thumbnail for Google Drive + server cache
      fullDataUrl = renderVariant(1200, 0.8);
      thumbDataUrl = renderVariant(420, 0.72);
      const uploaded = await uploadImageToDriveViaServer({
        base64Data: fullDataUrl,
        thumbBase64: thumbDataUrl,
        mimeType: 'image/jpeg',
        fileName: `coffeenadu-${Date.now()}.jpg`,
      });
      return {
        imageUrl: uploaded.imageUrl,
        imageThumbUrl: uploaded.imageThumbUrl,
        imageDriveId: uploaded.fileId,
        uploadedToDrive: true,
        deduplicated: uploaded.deduplicated,
      };
    }

    // Fallback: compress under Firestore document size limit
    const attempts: { maxDim: number; quality: number }[] = [
      { maxDim: 960, quality: 0.78 },
      { maxDim: 800, quality: 0.68 },
      { maxDim: 640, quality: 0.58 },
      { maxDim: 520, quality: 0.48 },
    ];
    for (const attempt of attempts) {
      const candidate = renderVariant(attempt.maxDim, attempt.quality);
      if (candidate.length <= MAX_FIRESTORE_IMAGE_CHARS) {
        return {
          imageUrl: candidate,
          uploadedToDrive: false,
        };
      }
    }
    throw new Error(
      'Photo is still too large after compression. Please pick a smaller image or crop it first.'
    );
  } finally {
    source.cleanup();
  }
}

export function AdminArticleModal({
  isOpen,
  editingArticle,
  existingArticleIds = [],
  isSaving,
  onClose,
  onSubmit,
}: AdminArticleModalProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const richController = useRichTextController('headline');
  const [customSlugInput, setCustomSlugInput] = useState('');
  const [titleKannada, setTitleKannada] = useState('');
  const [summaryKannada, setSummaryKannada] = useState('');
  const [bodyKannada, setBodyKannada] = useState('');
  const [category, setCategory] = useState<NewsCategory>('Local');
  const [location, setLocation] = useState<string>(KOPPA_LOCATIONS[0]);
  const [reporter, setReporter] = useState('Coffeenadu Desk');
  const [imageKey, setImageKey] = useState<ImageKey>('none');
  const [imageUrl, setImageUrl] = useState('');
  const [imageThumbUrl, setImageThumbUrl] = useState('');
  const [imageDriveId, setImageDriveId] = useState('');
  const [watermarkApplied, setWatermarkApplied] = useState(false);
  const [imageCaption, setImageCaption] = useState('');
  const [isFeatured, setIsFeatured] = useState(false);
  const [alsoAddToProgram, setAlsoAddToProgram] = useState(false);
  const [programDate, setProgramDate] = useState(getTodayYmd());
  const [programTime, setProgramTime] = useState('10:00 AM');
  const [programOrganizer, setProgramOrganizer] = useState('');
  const [isProcessingImage, setIsProcessingImage] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    if (editingArticle) {
      setTitleKannada(fieldValueToEditorHtml(editingArticle.titleKannada));
      setSummaryKannada(fieldValueToEditorHtml(editingArticle.summaryKannada));
      setBodyKannada(paragraphsToEditorHtml(editingArticle.bodyKannada));
      setCategory(editingArticle.category);
      const mappedLoc = getKannadaLocationLabel(editingArticle.location);
      setLocation(KOPPA_LOCATIONS.includes(mappedLoc) ? mappedLoc : KOPPA_LOCATIONS[0]);
      setReporter(editingArticle.reporter);
      setImageKey(editingArticle.imageKey || 'none');
      setImageUrl(editingArticle.imageUrl || '');
      setImageThumbUrl(editingArticle.imageThumbUrl || '');
      setImageDriveId(editingArticle.imageDriveId || '');
      setWatermarkApplied(Boolean(editingArticle.watermarkApplied && editingArticle.imageUrl));
      setImageCaption(fieldValueToEditorHtml(editingArticle.imageCaption || ''));
      setIsFeatured(Boolean(editingArticle.isFeatured));
    } else {
      setTitleKannada('');
      setSummaryKannada('');
      setBodyKannada('');
      setCategory('Local');
      setLocation(KOPPA_LOCATIONS[0]);
      setReporter('Coffeenadu Desk');
      setImageKey('none');
      setImageUrl('');
      setImageThumbUrl('');
      setImageDriveId('');
      setWatermarkApplied(false);
      setImageCaption('');
      setIsFeatured(false);
    }
    setCustomSlugInput('');
    setAlsoAddToProgram(false);
    setProgramDate(getTodayYmd());
    setProgramTime('10:00 AM');
    setProgramOrganizer('');
    setIsSubmitting(false);
    setErrorMessage('');
  }, [isOpen, editingArticle]);

  const existingIdsSet = useMemo(
    () => new Set(existingArticleIds.map((id) => id.trim().toLowerCase())),
    [existingArticleIds]
  );

  const formattedCustomSlug = useMemo(
    () => formatCustomEnglishSlug(customSlugInput),
    [customSlugInput]
  );

  const customSlugValidation = useMemo(
    () => validateCustomEnglishSlugInput(customSlugInput),
    [customSlugInput]
  );

  const isDuplicateCustomSlug = Boolean(
    !editingArticle &&
      formattedCustomSlug &&
      existingIdsSet.has(formattedCustomSlug.toLowerCase())
  );

  if (!isOpen) return null;

  const previewUrl =
    imageUrl ||
    resolveArticleImage({
      id: 'preview',
      titleKannada: '',
      summaryKannada: '',
      bodyKannada: [],
      category,
      location,
      publishedDate: '',
      publishedTime: '',
      readTimeMinutes: 1,
      reporter,
      imageKey,
      imageUrl: imageUrl || undefined,
    });

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!isLikelyImageFile(file)) {
      setErrorMessage('Please choose an image file (JPG, PNG, WebP, or GIF).');
      return;
    }

    setErrorMessage('');
    setIsProcessingImage(true);
    try {
      const processed = await processAndUploadNewsPhoto(file);
      setImageUrl(processed.imageUrl);
      setImageThumbUrl(processed.imageThumbUrl || '');
      setImageDriveId(processed.imageDriveId || '');
      setWatermarkApplied(true);
      setImageKey('none');
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Unable to process the selected photo.'
      );
    } finally {
      setIsProcessingImage(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (isSubmitting || isSaving || isProcessingImage) return;

    const cleanTitle = sanitizeInlineRichTextHtml(titleKannada, false);
    const plainTitle = stripRichTextToPlainText(cleanTitle);
    const paragraphs = editorHtmlToParagraphs(bodyKannada);
    const plainFirstParagraph = stripRichTextToPlainText(paragraphs[0] || '');
    const cleanSummaryRaw = sanitizeInlineRichTextHtml(summaryKannada, true);
    const cleanSummary = (
      stripRichTextToPlainText(cleanSummaryRaw) ? cleanSummaryRaw : plainFirstParagraph
    ).slice(0, 2500);
    const cleanCaption = sanitizeInlineRichTextHtml(imageCaption, false);

    if (!plainTitle || paragraphs.length === 0) {
      setErrorMessage('Please enter both the Kannada Headline and Full Report before publishing.');
      return;
    }

    if (!editingArticle && customSlugInput.trim()) {
      if (customSlugValidation.error) {
        setErrorMessage(customSlugValidation.error);
        return;
      }
      if (isDuplicateCustomSlug) {
        setErrorMessage(
          `The custom English URL "${formattedCustomSlug}" is already used by another article. Please choose a different English URL.`
        );
        return;
      }
    }

    if (alsoAddToProgram && (!programDate || !/^\d{4}-\d{2}-\d{2}$/.test(programDate))) {
      setErrorMessage('Please select a valid scheduled date for the Program & Events calendar.');
      return;
    }

    setErrorMessage('');
    setIsSubmitting(true);
    try {
      let finalImageUrl = imageUrl.trim();
      let finalWatermarkApplied = Boolean(finalImageUrl && watermarkApplied);
      if (finalImageUrl && !finalWatermarkApplied) {
        try {
          finalImageUrl = await applyWatermarkToImageSrc(finalImageUrl);
          finalWatermarkApplied = true;
        } catch {
          // Keep original URL if external CORS blocks re-encoding; canvas component handles rendering
        }
      }

      await onSubmit({
        customSlug: !editingArticle && formattedCustomSlug ? formattedCustomSlug : undefined,
        titleKannada: cleanTitle,
        summaryKannada: cleanSummary,
        bodyKannada: paragraphs,
        category,
        location,
        reporter: reporter.trim() || 'Coffeenadu Desk',
        imageKey,
        imageUrl: finalImageUrl,
        imageThumbUrl: finalImageUrl ? imageThumbUrl || undefined : undefined,
        imageDriveId: finalImageUrl ? imageDriveId || undefined : undefined,
        imageCaption: stripRichTextToPlainText(cleanCaption) ? cleanCaption.slice(0, 1000) : undefined,
        isFeatured,
        watermarkApplied: finalWatermarkApplied,
        alsoAddToProgram,
        programDate: alsoAddToProgram ? programDate : undefined,
        programTime: alsoAddToProgram ? programTime.trim() || '10:00 AM' : undefined,
        programOrganizer: alsoAddToProgram
          ? programOrganizer.trim() || reporter.trim() || 'Koppa Taluk Committee'
          : undefined,
      });
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Unable to save article.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="admin-article-modal-title"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-3xl shadow-lg overflow-hidden my-auto flex flex-col max-h-[92vh]">
        <div className="flex items-center justify-between px-6 py-3.5 border-b border-slate-200 shrink-0">
          <div>
            <h2 id="admin-article-modal-title" className="text-lg font-bold text-slate-950">
              {editingArticle ? 'Edit News Article' : 'Add News Article'}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              One formatting toolbar below works for Headline, Summary, Full Report &amp; Photo Caption
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="p-2 text-slate-500 hover:text-slate-900 rounded-md hover:bg-slate-100 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Single Unified Sticky MS Word-Style Formatting Toolbar for ALL text fields */}
        <RichTextToolbar controller={richController} className="shrink-0 z-20" />

        <form onSubmit={handleSubmit} className="p-6 space-y-4 flex-1 overflow-y-auto">
          {errorMessage && (
            <div
              role="alert"
              className="px-3.5 py-2.5 text-xs font-medium text-red-800 bg-red-50 border border-red-200 rounded-md"
            >
              {errorMessage}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="admin-category" className="block text-xs font-semibold text-slate-700 mb-1.5">
                Category
              </label>
              <select
                id="admin-category"
                value={category}
                onChange={(e) => setCategory(e.target.value as NewsCategory)}
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:border-[#0F274A] min-h-[40px]"
              >
                {NEWS_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="admin-location" className="block text-xs font-semibold text-slate-700 mb-1.5">
                Town / Hobli
              </label>
              <select
                id="admin-location"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:border-[#0F274A] min-h-[40px]"
              >
                {KOPPA_LOCATIONS.map((loc) => (
                  <option key={loc} value={loc}>
                    {loc}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="admin-title" className="block text-xs font-semibold text-slate-700 mb-1.5">
              Headline (Kannada — Select text &amp; use top Bold / Font / Size bar)
            </label>
            <RichTextField
              id="admin-title"
              fieldId="headline"
              fieldLabel="Headline"
              controller={richController}
              value={titleKannada}
              onChange={setTitleKannada}
              singleLine
              minHeightClass="min-h-[44px]"
              maxHeightClass="max-h-[120px]"
              contentClassName="text-base font-semibold leading-snug"
              placeholder="ಕನ್ನಡದಲ್ಲಿ ಸುದ್ದಿಯ ಶೀರ್ಷಿಕೆ ಬರೆಯಿರಿ..."
            />
          </div>

          {!editingArticle ? (
            <div className="border border-slate-200 rounded-lg p-3.5 bg-slate-50/70 space-y-1.5">
              <label
                htmlFor="admin-custom-english-url"
                className="flex items-center gap-1.5 text-xs font-semibold text-slate-700"
              >
                <Link2 className="w-3.5 h-3.5 text-[#0F274A]" aria-hidden="true" />
                <span>Custom English URL (Optional)</span>
              </label>
              <input
                id="admin-custom-english-url"
                type="text"
                maxLength={100}
                value={customSlugInput}
                onChange={(e) => setCustomSlugInput(e.target.value)}
                placeholder="e.g. article 1 or koppa-coffee-price"
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-[#0F274A] min-h-[40px]"
              />
              {customSlugInput.trim() ? (
                customSlugValidation.error ? (
                  <p className="text-[11px] font-medium text-red-700">
                    {customSlugValidation.error}
                  </p>
                ) : isDuplicateCustomSlug ? (
                  <p className="text-[11px] font-medium text-red-700">
                    &ldquo;{formattedCustomSlug}&rdquo; is already used by another article. Please choose a different English URL.
                  </p>
                ) : (
                  <p className="text-[11px] text-emerald-900 break-all">
                    Will publish automatically at:{' '}
                    <span className="font-semibold">
                      {buildArticlePublicUrl(formattedCustomSlug)}
                    </span>
                  </p>
                )
              ) : (
                <p className="text-[11px] text-slate-500">
                  Enter English words/numbers (spaces become hyphens, e.g. &ldquo;article 1&rdquo; →{' '}
                  <span className="font-medium text-slate-700">/?article=article-1</span>). Leave blank to auto-generate.
                </p>
              )}
            </div>
          ) : (
            <div className="px-3 py-2 rounded-md bg-slate-50 border border-slate-200 text-[11px] text-slate-600 flex items-center gap-1.5 break-all">
              <Link2 className="w-3.5 h-3.5 text-slate-500 shrink-0" aria-hidden="true" />
              <span>
                Article URL (locked for existing news):{' '}
                <strong className="text-slate-800 font-medium">
                  {buildArticlePublicUrl(editingArticle.id)}
                </strong>
              </span>
            </div>
          )}

          <div>
            <label htmlFor="admin-summary" className="block text-xs font-semibold text-slate-700 mb-1.5">
              Short Summary / Description (Kannada — Optional, auto-filled if blank)
            </label>
            <RichTextField
              id="admin-summary"
              fieldId="summary"
              fieldLabel="Short Summary"
              controller={richController}
              value={summaryKannada}
              onChange={setSummaryKannada}
              minHeightClass="min-h-[68px]"
              maxHeightClass="max-h-[160px]"
              contentClassName="text-sm leading-relaxed"
              placeholder="ಸುದ್ದಿಯ ಸಾರಾಂಶವನ್ನು 1-2 ವಾಕ್ಯಗಳಲ್ಲಿ ಬರೆಯಿರಿ..."
            />
          </div>

          <div>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
              <label htmlFor="admin-body" className="block text-xs font-semibold text-slate-700">
                Full Report (Kannada)
              </label>
              <span className="text-[11px] text-slate-500">
                Formatted via the single top toolbar
              </span>
            </div>
            <RichTextField
              id="admin-body"
              fieldId="body"
              fieldLabel="Full Report"
              controller={richController}
              value={bodyKannada}
              onChange={setBodyKannada}
              minHeightClass="min-h-[210px]"
              maxHeightClass="max-h-[380px]"
              contentClassName="text-[15px] leading-[1.8]"
              showStats
              placeholder="ಸಂಪೂರ್ಣ ವರದಿಯನ್ನು ಕನ್ನಡದಲ್ಲಿ ನಮೂದಿಸಿ (Select any word & use top Bold / Font / Size bar)..."
            />
          </div>

          {/* Photo Upload Section */}
          <div className="border border-slate-200 rounded-lg p-4 bg-slate-50/70 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-800">
                News Photo (Device Upload or Preset)
              </span>
              {imageUrl && (
                <button
                  type="button"
                  onClick={() => {
                    setImageUrl('');
                    setWatermarkApplied(false);
                  }}
                  className="inline-flex items-center gap-1 text-xs font-medium text-red-700 hover:underline cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Remove Uploaded Photo</span>
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start">
              <div>
                <input
                  ref={fileInputRef}
                  id="admin-file-upload"
                  type="file"
                  accept="image/*"
                  onChange={handleFileChange}
                  className="sr-only"
                />
                <label
                  htmlFor="admin-file-upload"
                  className="flex items-center justify-center gap-2 w-full px-4 py-2.5 text-xs font-semibold text-[#0F274A] bg-white border border-slate-300 hover:border-[#0F274A] rounded-md cursor-pointer transition-colors min-h-[42px]"
                >
                  <ImagePlus className="w-4 h-4" aria-hidden="true" />
                  <span>{isProcessingImage ? 'Applying logo & optimizing...' : 'Upload Photo (Mobile / PC)'}</span>
                </label>
                <p className="text-[11px] text-slate-500 mt-1.5">
                  Automatically applies the circular CoffeeNadu logo watermark and optimizes for fast loading
                </p>
              </div>

              <div>
                <label htmlFor="admin-image-preset" className="sr-only">
                  Or choose preset Koppa photo
                </label>
                <select
                  id="admin-image-preset"
                  value={imageUrl ? 'none' : imageKey}
                  onChange={(e) => {
                    setImageKey(e.target.value as ImageKey);
                    setImageUrl('');
                    setWatermarkApplied(false);
                  }}
                  className="w-full px-3 py-2 text-xs font-medium bg-white border border-slate-300 rounded-md text-slate-800 focus:outline-none focus:border-[#0F274A] min-h-[42px]"
                >
                  {IMAGE_PRESETS.map((preset) => (
                    <option key={preset.key} value={preset.key}>
                      {preset.key === 'none'
                        ? `Auto: Use ${category} Section Preset`
                        : `Preset: ${preset.label}`}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-slate-500 mt-1.5">
                  Automatically uses the {category} section preset if no photo is uploaded
                </p>
              </div>
            </div>

            {previewUrl && (
              <div className="pt-1">
                <NewsImage
                  src={previewUrl}
                  alt="Selected article preview"
                  aspectClass="aspect-[16/9]"
                  watermarkApplied={Boolean(imageUrl && watermarkApplied)}
                  className="max-h-48 rounded-md border border-slate-200"
                />
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="admin-image-caption" className="block text-xs font-semibold text-slate-700 mb-1.5">
                Photo Caption (Kannada, Optional)
              </label>
              <RichTextField
                id="admin-image-caption"
                fieldId="caption"
                fieldLabel="Photo Caption"
                controller={richController}
                value={imageCaption}
                onChange={setImageCaption}
                singleLine
                minHeightClass="min-h-[40px]"
                maxHeightClass="max-h-[100px]"
                contentClassName="text-sm leading-snug"
                placeholder="ಚಿತ್ರದ ವಿವರಣೆ..."
              />
            </div>

            <div>
              <label htmlFor="admin-reporter" className="block text-xs font-semibold text-slate-700 mb-1.5">
                Reporter Name
              </label>
              <input
                id="admin-reporter"
                type="text"
                maxLength={100}
                value={reporter}
                onChange={(e) => setReporter(e.target.value)}
                placeholder="Coffeenadu Desk"
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-[#0F274A] min-h-[40px]"
              />
            </div>
          </div>

          <label className="flex items-center gap-2.5 text-sm text-slate-800 cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={isFeatured}
              onChange={(e) => setIsFeatured(e.target.checked)}
              className="w-4 h-4 accent-[#0F274A] rounded"
            />
            <span>Pin as Featured Lead Story (multiple lead stories slide automatically on the front page)</span>
          </label>

          {/* Optional Cross-Publish to Programs & Events Calendar */}
          <div className="border border-emerald-200 bg-emerald-50/50 rounded-lg p-4 space-y-3">
            <label className="flex items-start gap-2.5 text-sm text-slate-900 cursor-pointer">
              <input
                type="checkbox"
                checked={alsoAddToProgram}
                onChange={(e) => setAlsoAddToProgram(e.target.checked)}
                className="w-4 h-4 mt-0.5 accent-emerald-800 rounded shrink-0"
              />
              <div>
                <span className="font-semibold block">
                  Also add to Programs &amp; Events calendar
                </span>
                <span className="text-xs text-slate-600">
                  Displays this story in both the News section and the Programs &amp; Events calendar (green-marked date)
                </span>
              </div>
            </label>

            {alsoAddToProgram && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-emerald-200/80">
                <div>
                  <label htmlFor="news-program-date" className="block text-xs font-semibold text-slate-700 mb-1">
                    Program Date
                  </label>
                  <input
                    id="news-program-date"
                    type="date"
                    required={alsoAddToProgram}
                    value={programDate}
                    onChange={(e) => setProgramDate(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:border-emerald-700 min-h-[40px]"
                  />
                </div>

                <div>
                  <label htmlFor="news-program-time" className="block text-xs font-semibold text-slate-700 mb-1">
                    Program Time
                  </label>
                  <input
                    id="news-program-time"
                    type="text"
                    maxLength={40}
                    value={programTime}
                    onChange={(e) => setProgramTime(e.target.value)}
                    placeholder="10:00 AM"
                    className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:border-emerald-700 min-h-[40px]"
                  />
                </div>

                <div>
                  <label htmlFor="news-program-organizer" className="block text-xs font-semibold text-slate-700 mb-1">
                    Organizer (Optional)
                  </label>
                  <input
                    id="news-program-organizer"
                    type="text"
                    maxLength={100}
                    value={programOrganizer}
                    onChange={(e) => setProgramOrganizer(e.target.value)}
                    placeholder={reporter || 'Koppa Taluk Committee'}
                    className="w-full px-3 py-2 text-sm font-kannada bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:border-emerald-700 min-h-[40px]"
                  />
                </div>
              </div>
            )}
          </div>

          {errorMessage && (
            <div
              role="alert"
              className="px-3.5 py-2.5 text-xs font-medium text-red-800 bg-red-50 border border-red-200 rounded-md"
            >
              {errorMessage}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting || isSaving || isProcessingImage}
              className="px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 rounded-md transition-colors cursor-pointer min-h-[40px]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || isSaving || isProcessingImage}
              className="inline-flex items-center justify-center gap-2 px-5 py-2 text-sm font-semibold text-white bg-[#0F274A] hover:bg-[#173a6e] disabled:opacity-60 rounded-md transition-colors cursor-pointer min-h-[40px]"
            >
              {(isSubmitting || isSaving) && (
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              )}
              <span>
                {isSubmitting || isSaving
                  ? 'Publishing...'
                  : editingArticle
                  ? 'Save Changes'
                  : 'Publish Story'}
              </span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
