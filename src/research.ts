const EMAIL_RE = /[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+\d[\d\s().-]{7,}\d|\b\d{2,4}[\s().-]\d{3}[\s().-]\d{3,4}\b)/g;
const URL_RE = /https?:\/\/[^\s<>'"]+/gi;

export function unique(values: unknown[]): string[] {
  return [...new Set(values.map((value) => String(value).replace(/[.,);]+$/, "")).filter(Boolean))];
}

export function keepClassifiedItems<T>(items: T[], classifications: Array<{ status?: string; labels?: Record<string, string> }>, profile: { keep?: { dimension?: string; choices?: string[] } } = {}): T[] {
  const rule = profile.keep;
  return items.filter((_, index) => {
    const result = classifications[index];
    if (!result || result.status !== "classified") return false;
    if (!rule) return true;
    return (rule.choices ?? []).includes(result.labels?.[rule.dimension ?? ""] ?? "");
  });
}

export function enrichContactEvidence(item: any): { emails: string[]; phones: string[]; urls: string[] } {
  const text = [item?.text, item?.summary, item?.title].filter(Boolean).join(" ");
  const links = Array.isArray(item?.links) ? item.links.map((link: any) => typeof link === "string" ? link : link?.href).filter(Boolean) : [];
  const known = [item?.apply_url, ...(item?.apply_urls ?? []), ...(item?.external_urls ?? []), ...(item?.profile_urls ?? []), ...(item?.company_urls ?? [])].filter(Boolean);
  return {
    emails: unique([...(text.match(EMAIL_RE) ?? []), ...(item?.emails ?? [])]),
    phones: unique([...(text.match(PHONE_RE) ?? []), ...(item?.phones ?? [])]),
    urls: unique([...links, ...known, ...(text.match(URL_RE) ?? [])]),
  };
}

export function allowedFollowUpTarget(target: string, hosts: string[] = []): boolean {
  if (!Array.isArray(hosts) || !hosts.length) return false;
  try {
    const url = new URL(target);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    const hostname = url.hostname.toLowerCase();
    return hosts.some((host) => {
      const allowed = String(host).toLowerCase().replace(/^\.+/, "");
      return allowed && (hostname === allowed || hostname.endsWith(`.${allowed}`));
    });
  } catch { return false; }
}
