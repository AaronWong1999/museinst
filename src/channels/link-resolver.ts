//
// Link Resolver (spec §8.2/§14.3) — every external-facing URL is minted
// server-side at delivery/JIT time. Cards and canonical messages carry only
// stable object references; raw provider URLs (e.g. Cloudflare Live View JWTs)
// are never stored or embedded here.
//

export interface LinkResolver {
  /** /b/<opaque-grant> — one-time browser access grant redemption link. */
  browserGrant(token: string): string;
  /** /a/<approvalRef> — approval deep link for chat surfaces. */
  approval(approvalRef: string): string;
  /** /files/<fileRef> — short-lived file access link for chat surfaces. */
  file(fileRef: string): string;
  /** /t/<taskRef> — task detail link. */
  task(taskRef: string): string;
}

export interface LinkResolverHost {
  /** Deployment base URL, e.g. https://openinst.com (no trailing slash). */
  baseUrl: string;
}

/**
 * Default resolver used by the channel renderers. Hosts may override the
 * baseUrl via env/hook; the path scheme is the canonical MuseInst surface.
 */
export function createLinkResolver(host: LinkResolverHost): LinkResolver {
  const base = host.baseUrl.replace(/\/$/, "");
  const enc = (ref: string) => encodeURIComponent(ref);
  return {
    browserGrant: (token) => `${base}/b/${enc(token)}`,
    approval: (ref) => `${base}/a/${enc(ref)}`,
    file: (ref) => `${base}/files/${enc(ref)}`,
    task: (ref) => `${base}/t/${enc(ref)}`,
  };
}
