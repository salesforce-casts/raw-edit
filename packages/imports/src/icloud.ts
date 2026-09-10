import {
  ImportError,
  type CloudImportCredentials,
  type CloudImportProvider,
  type RemoteFileStream,
  type ResolvedRemoteFile,
} from '@rawedit/core';
import { assertIsVideo, fetchWithErrors, toRemoteStream } from './http.js';

/**
 * iCloud shared links, handled separately from the other providers because they
 * behave differently in ways that matter:
 *
 *  - there is no OAuth API for iCloud Drive or Shared Albums, so only a public
 *    `share/#B0xxxx` link can be resolved at all;
 *  - the resolved download URL is short-lived (typically well under an hour), so it
 *    must be consumed immediately rather than stored and retried later;
 *  - a Shared Album serves a **transcoded** derivative for many assets, so the
 *    "original quality" promise cannot always be kept, and we say so rather than
 *    quietly importing a compressed copy.
 *
 * The CloudKit web endpoint used here is the same one Apple's own share page calls.
 */
export class ICloudImporter implements CloudImportProvider {
  readonly kind = 'ICLOUD' as const;
  readonly name = 'iCloud';

  canHandle(url: string): boolean {
    return /icloud\.com/i.test(url);
  }

  isConfigured(): boolean {
    // Public share links need no credentials; there is nothing to configure.
    return true;
  }

  /** `https://www.icloud.com/sharedalbum/#B0abcdef` -> `B0abcdef` */
  static extractToken(url: string): string | null {
    const match = /#([A-Za-z0-9]{6,})/.exec(url) ?? /\/share\/([A-Za-z0-9_-]{6,})/.exec(url);
    return match?.[1] ?? null;
  }

  /** Apple shards the web service by the first character after the `B` prefix. */
  static partitionHost(token: string): string {
    const shard = token.slice(1, 2).toLowerCase();
    const partition = /^[0-9]$/.test(shard) ? shard : '1';
    return `https://p${partition}-sharedstreams.icloud.com`;
  }

  async resolve(url: string, _credentials?: CloudImportCredentials): Promise<ResolvedRemoteFile> {
    const token = ICloudImporter.extractToken(url);
    if (!token) {
      throw new ImportError(
        'That does not look like an iCloud share link. Use the link from the Share button.',
        'UNSUPPORTED_URL',
      );
    }

    const base = `${ICloudImporter.partitionHost(token)}/${token}/sharedstreams`;
    const response = await fetchWithErrors(
      `${base}/webstream`,
      {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ streamCtag: null }),
      },
      'the iCloud shared album',
    );

    const stream = (await response.json()) as {
      photos?: {
        photoGuid: string;
        mediaAssetType?: string;
        derivatives?: Record<string, { fileSize?: string; checksum?: string; width?: string; height?: string }>;
      }[];
    };

    const video = stream.photos?.find((photo) => photo.mediaAssetType === 'video');
    if (!video) {
      throw new ImportError(
        'No video was found at that iCloud link. Shared Albums must contain a video for this to work.',
        'NOT_A_VIDEO',
      );
    }

    // Pick the largest derivative; Apple does not always publish the true original.
    const derivatives = Object.entries(video.derivatives ?? {});
    const largest = derivatives
      .map(([key, value]) => ({ key, size: Number.parseInt(value.fileSize ?? '0', 10) }))
      .sort((a, b) => b.size - a.size)[0];

    const filename = `icloud-${video.photoGuid.slice(0, 8)}.mov`;
    assertIsVideo(filename, 'video/quicktime');

    return {
      kind: this.kind,
      externalId: video.photoGuid,
      filename,
      mimeType: 'video/quicktime',
      size: largest?.size ?? null,
      // Shared Albums serve a derivative, not necessarily the camera original.
      isOriginal: false,
      notes: [
        'iCloud Shared Albums serve a derivative of the video, so this may not be the untouched camera original.',
        'iCloud download links expire quickly, so the import starts immediately and cannot be resumed later.',
      ],
    };
  }

  async open(url: string, credentials?: CloudImportCredentials): Promise<RemoteFileStream> {
    const resolved = await this.resolve(url, credentials);
    const token = ICloudImporter.extractToken(url)!;
    const base = `${ICloudImporter.partitionHost(token)}/${token}/sharedstreams`;

    const response = await fetchWithErrors(
      `${base}/webasseturls`,
      {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ photoGuids: [resolved.externalId] }),
      },
      'the iCloud asset URL',
    );

    const payload = (await response.json()) as {
      items?: Record<string, { url_location?: string; url_path?: string }>;
    };
    const items = Object.values(payload.items ?? {});
    const item = items[0];
    if (!item?.url_location || !item.url_path) {
      throw new ImportError(
        'The iCloud link no longer has a downloadable asset. These links expire — please re-share it.',
        'EXPIRED',
      );
    }

    const assetUrl = `https://${item.url_location}${item.url_path}`;
    const asset = await fetchWithErrors(assetUrl, {}, 'the iCloud video');
    return toRemoteStream(asset);
  }
}
