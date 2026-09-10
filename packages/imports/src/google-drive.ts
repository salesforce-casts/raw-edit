import {
  ImportError,
  type CloudImportCredentials,
  type CloudImportProvider,
  type RemoteFileStream,
  type ResolvedRemoteFile,
} from '@rawedit/core';
import { assertIsVideo, fetchWithErrors, toRemoteStream } from './http.js';

/**
 * Google Drive.
 *
 * Always fetches `alt=media`, which is the **original uploaded bytes**. Drive's
 * `webContentLink` and its player serve transcoded renditions; using those would
 * silently degrade quality, which is the one thing this product must not do.
 */
export class GoogleDriveImporter implements CloudImportProvider {
  readonly kind = 'GOOGLE_DRIVE' as const;
  readonly name = 'Google Drive';
  private readonly apiBase = 'https://www.googleapis.com/drive/v3/files';

  canHandle(url: string): boolean {
    return /(?:drive|docs)\.google\.com/i.test(url);
  }

  isConfigured(credentials?: CloudImportCredentials): boolean {
    return Boolean(credentials?.accessToken ?? credentials?.apiKey ?? process.env['GOOGLE_DRIVE_API_KEY']);
  }

  /**
   * Drive links come in several shapes:
   *   /file/d/<id>/view      /open?id=<id>      /uc?id=<id>&export=download
   */
  static extractFileId(url: string): string | null {
    const patterns = [
      /\/file\/d\/([a-zA-Z0-9_-]{10,})/,
      /[?&]id=([a-zA-Z0-9_-]{10,})/,
      /\/d\/([a-zA-Z0-9_-]{10,})/,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(url);
      if (match?.[1]) return match[1];
    }
    return null;
  }

  private auth(credentials?: CloudImportCredentials): { headers: Record<string, string>; query: string } {
    if (credentials?.accessToken) {
      return { headers: { authorization: `Bearer ${credentials.accessToken}` }, query: '' };
    }
    const apiKey = credentials?.apiKey ?? process.env['GOOGLE_DRIVE_API_KEY'];
    if (apiKey) return { headers: {}, query: `&key=${encodeURIComponent(apiKey)}` };

    throw new ImportError(
      'Google Drive import needs either a connected account or GOOGLE_DRIVE_API_KEY for public links.',
      'NOT_CONFIGURED',
    );
  }

  async resolve(url: string, credentials?: CloudImportCredentials): Promise<ResolvedRemoteFile> {
    const fileId = GoogleDriveImporter.extractFileId(url);
    if (!fileId) {
      throw new ImportError(
        'That does not look like a Google Drive file link. Open the file and copy the link from the address bar.',
        'UNSUPPORTED_URL',
      );
    }

    const { headers, query } = this.auth(credentials);
    const metadataUrl =
      `${this.apiBase}/${fileId}?fields=id,name,mimeType,size,videoMediaMetadata,shortcutDetails` +
      `&supportsAllDrives=true${query}`;

    const response = await fetchWithErrors(metadataUrl, { headers }, 'the Google Drive file');
    const file = (await response.json()) as {
      id: string;
      name?: string;
      mimeType?: string;
      size?: string;
      shortcutDetails?: { targetId?: string; targetMimeType?: string };
    };

    if (file.mimeType === 'application/vnd.google-apps.folder') {
      throw new ImportError('That link points at a folder. Share the video file itself.', 'NOT_A_VIDEO');
    }
    if (file.mimeType?.startsWith('application/vnd.google-apps')) {
      throw new ImportError(
        'That is a Google Docs-type file, which has no original video to download.',
        'NOT_A_VIDEO',
      );
    }

    const filename = file.name ?? 'google-drive-video';
    assertIsVideo(filename, file.mimeType ?? null);

    return {
      kind: this.kind,
      externalId: file.shortcutDetails?.targetId ?? file.id,
      filename,
      mimeType: file.mimeType ?? null,
      size: file.size ? Number.parseInt(file.size, 10) : null,
      // alt=media returns the bytes as uploaded.
      isOriginal: true,
      notes: [],
    };
  }

  async open(url: string, credentials?: CloudImportCredentials): Promise<RemoteFileStream> {
    const resolved = await this.resolve(url, credentials);
    const { headers, query } = this.auth(credentials);
    const downloadUrl =
      `${this.apiBase}/${resolved.externalId}?alt=media&supportsAllDrives=true` +
      `&acknowledgeAbuse=true${query}`;

    const response = await fetchWithErrors(downloadUrl, { headers }, 'the Google Drive file');
    return toRemoteStream(response);
  }
}
