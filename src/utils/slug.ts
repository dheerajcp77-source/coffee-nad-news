const RESERVED_ARTICLE_SLUGS = new Set([
  'admin',
  'events',
  'bus-timings',
  'chat',
  'api',
  'assets',
  'index',
  'login',
]);

/**
 * Formats an admin-entered English URL phrase into a clean, lowercase,
 * URL-safe slug (e.g., "article 1" -> "article-1", "Koppa Rain!" -> "koppa-rain").
 */
export function formatCustomEnglishSlug(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

export function validateCustomEnglishSlugInput(raw: string): {
  slug: string;
  error?: string;
} {
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    return { slug: '' };
  }

  const slug = formatCustomEnglishSlug(trimmed);
  if (!slug) {
    return {
      slug: '',
      error:
        'Please use English letters and numbers for the custom URL (for example: article 1 or koppa-coffee-price).',
    };
  }

  if (RESERVED_ARTICLE_SLUGS.has(slug)) {
    return {
      slug: '',
      error: `"${slug}" is a reserved website route. Please choose a different English URL (for example: news-${slug}).`,
    };
  }

  return { slug };
}

export function buildArticlePublicUrl(articleId: string, origin?: string): string {
  const base =
    origin !== undefined
      ? origin.replace(/\/+$/, '')
      : typeof window !== 'undefined'
      ? window.location.origin
      : '';
  return `${base}/?article=${encodeURIComponent(articleId)}`;
}
