import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import {
  ImportError,
  type CloudImportCredentials,
  type CloudImportProvider,
  type RemoteFileStream,
  type ResolvedRemoteFile,
} from '@rawedit/core';
import { assertIsVideo, fetchWithErrors, filenameFrom, toRemoteStream } from './http.js';

/**
 * A plain HTTPS link to a video file.
 *
 * This is the fallback for anything the named providers do not claim, and it is the
 * one adapter that fetches a user-supplied URL directly — so it is also the one that
 * has to refuse to be pointed at internal infrastructure.
 */
export class DirectUrlImporter implements CloudImportProvider {
  readonly kind = 'URL' as const;
  readonly name = 'Direct link';

  canHandle(url: string): boolean {
    return /^https?:\/\//i.test(url);
  }

  isConfigured(): boolean {
    return true;
  }

  async resolve(url: string, _credentials?: CloudImportCredentials): Promise<ResolvedRemoteFile> {
    await assertPublicUrl(url);
    const response = await fetchWithErrors(url, { method: 'HEAD' }, 'that link');
    const filename = filenameFrom(response, url);
    const mimeType = response.headers.get('content-type');
    assertIsVideo(filename, mimeType);

    const length = response.headers.get('content-length');
    const acceptsRanges = response.headers.get('accept-ranges') === 'bytes';

    return {
      kind: this.kind,
      externalId: null,
      filename,
      mimeType,
      size: length ? Number.parseInt(length, 10) : null,
      isOriginal: true,
      notes: acceptsRanges ? [] : ['This server does not support range requests, so the import cannot resume.'],
    };
  }

  async open(url: string, _credentials?: CloudImportCredentials): Promise<RemoteFileStream> {
    await assertPublicUrl(url);
    const response = await fetchWithErrors(url, {}, 'that link');
    return toRemoteStream(response);
  }
}

/**
 * Server-side request forgery guard.
 *
 * The worker sits inside our own network, so a user-supplied URL must never be
 * allowed to resolve to a private address, link-local metadata, or loopback.
 */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ImportError('That is not a valid URL.', 'UNSUPPORTED_URL');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ImportError('Only http and https links can be imported.', 'UNSUPPORTED_URL');
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const addresses: string[] = [];

  if (isIP(host)) {
    addresses.push(host);
  } else {
    try {
      const resolved = await lookup(host, { all: true });
      addresses.push(...resolved.map((entry) => entry.address));
    } catch {
      throw new ImportError(`Could not resolve ${host}.`, 'NOT_FOUND');
    }
  }

  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new ImportError('That link resolves to a private address and cannot be imported.', 'FORBIDDEN');
    }
  }
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    const parts = address.split('.').map(Number);
    const [a = 0, b = 0] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    // Link-local, including the 169.254.169.254 cloud metadata endpoint.
    if (a === 169 && b === 254) return true;
    // Carrier-grade NAT.
    if (a === 100 && b >= 64 && b <= 127) return true;
    return a >= 224;
  }

  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized === '::1' || normalized === '::') return true;
    // Unique local (fc00::/7) and link-local (fe80::/10).
    if (/^f[cd]/.test(normalized)) return true;
    if (/^fe[89ab]/.test(normalized)) return true;
    // IPv4-mapped addresses must be checked as IPv4.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return false;
  }

  return true;
}
