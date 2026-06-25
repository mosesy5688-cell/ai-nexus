/**
 * badgeUrl() — a PURE URL builder. It returns the badge SVG URL string and does
 * NOT fetch anything (Section 1, item [9]). Every JSON entity already carries
 * links.badge_url; this helper builds the same URL from an id/slug when you
 * don't have a full entity in hand.
 *
 * The badge route serves image/svg+xml (200 badge / 404 placeholder SVG). A
 * fetching badge() method is intentionally omitted — it adds little value and
 * the SDK avoids hidden requests.
 */
import { buildUrl } from "../http/query.js";

/**
 * Build the badge SVG URL for an entity id or umid slug (author--name form).
 * Does NOT validate that the badge exists and does NOT perform any request.
 */
export function badgeUrl(baseUrl: string, idOrSlug: string): string {
  const id = String(idOrSlug).trim();
  return buildUrl(baseUrl, `/api/v1/badge/${encodeURIComponent(id)}`);
}
