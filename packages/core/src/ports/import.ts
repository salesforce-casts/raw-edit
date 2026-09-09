import type { Readable } from 'node:stream';
import type { SourceKind } from '../types/status.js';

/**
 * Cloud import. Every provider resolves a user-supplied link to the **original
 * downloadable asset** — never the streaming or preview rendition those services
 * serve to their own players.
 */

export interface ResolvedRemoteFile {
  kind: SourceKind;
  externalId: string | null;
  filename: string;
  mimeType: string | null;
  /** Bytes, when the provider tells us up front. */
  size: number | null;
  /** True when we are confident this is the original upload, not a transcode. */
  isOriginal: boolean;
  /** Provider-specific notes surfaced to the user (e.g. iCloud link expiry). */
  notes: string[];
}

export interface RemoteFileStream {
  stream: Readable;
  size: number | null;
  mimeType: string | null;
}

export interface CloudImportCredentials {
  /** OAuth access token for the connected account, when the flow needs one. */
  accessToken?: string;
  /** API key for public-link access, when the provider supports it. */
  apiKey?: string;
}

export interface CloudImportProvider {
  readonly kind: SourceKind;
  readonly name: string;
  /** True when this provider can handle the given URL. */
  canHandle(url: string): boolean;
  /** True when the configuration needed for this provider is present. */
  isConfigured(credentials?: CloudImportCredentials): boolean;
  resolve(url: string, credentials?: CloudImportCredentials): Promise<ResolvedRemoteFile>;
  open(url: string, credentials?: CloudImportCredentials): Promise<RemoteFileStream>;
}

export class ImportError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'UNSUPPORTED_URL'
      | 'NOT_CONFIGURED'
      | 'NOT_FOUND'
      | 'FORBIDDEN'
      | 'EXPIRED'
      | 'NOT_A_VIDEO'
      | 'TOO_LARGE'
      | 'NETWORK',
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}
