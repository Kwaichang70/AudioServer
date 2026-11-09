import type { TrackMetadata } from '@audioserver/shared';

/**
 * Shared pieces of the UPnP controllers (Sonos and DLNA speak the same SOAP).
 */

/** How long one SOAP request to a speaker may take before it counts as failed (P05). */
export const SOAP_TIMEOUT_MS = 10_000;

/** A device description fetched while discovering (LOCATION of an SSDP answer). */
export const DESCRIPTION_TIMEOUT_MS = 3_000;

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * DIDL-Lite for `CurrentURIMetaData` / `NextURIMetaData`, as plain XML.
 *
 * It is a document inside a SOAP argument, so it must be escaped exactly once
 * more by whoever puts it into the envelope — the controllers escape every
 * argument the same way. Building it pre-escaped and then escaping again sent
 * `&amp;lt;DIDL-Lite…` (text, not XML) to Sonos and as the next track to DLNA;
 * not escaping the pre-escaped form left a bare `&` from a stream URL such as
 * `…/stream?t=…&zone=…` inside the DIDL, which is invalid XML (P04).
 */
export function buildDidlLite(
  uri: string,
  meta: TrackMetadata | undefined,
  mimeType?: string,
): string {
  const title = escapeXml(meta?.title || 'Unknown');
  const artist = escapeXml(meta?.artist || 'Unknown');
  const album = escapeXml(meta?.album || 'Unknown');
  const cover = meta?.coverUrl
    ? `<upnp:albumArtURI>${escapeXml(meta.coverUrl)}</upnp:albumArtURI>`
    : '';
  const protocol = mimeType ? ` protocolInfo="http-get:*:${escapeXml(mimeType)}:*"` : '';
  return (
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="1" parentID="0" restricted="true">' +
    `<dc:title>${title}</dc:title>` +
    `<dc:creator>${artist}</dc:creator>` +
    `<upnp:artist>${artist}</upnp:artist>` +
    `<upnp:album>${album}</upnp:album>` +
    cover +
    '<upnp:class>object.item.audioItem.musicTrack</upnp:class>' +
    `<res${protocol}>${escapeXml(uri)}</res>` +
    '</item></DIDL-Lite>'
  );
}

/** The mime type a resolver put on the metadata, when it did. */
export function mimeTypeOf(meta: TrackMetadata | undefined): string | undefined {
  const mime = (meta as (TrackMetadata & { mimeType?: unknown }) | undefined)?.mimeType;
  return typeof mime === 'string' && mime ? mime : undefined;
}

/**
 * The signal for one request to a speaker: its own time limit, plus the
 * caller's cancellation when the caller already gave up (P05, P06).
 */
export function requestSignal(signal?: AbortSignal, timeoutMs = SOAP_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}
