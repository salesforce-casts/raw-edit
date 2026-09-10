import { describe, expect, it } from 'vitest';
import { ImportError } from '@rawedit/core';
import { DropboxImporter } from '../src/dropbox.js';
import { GoogleDriveImporter } from '../src/google-drive.js';
import { OneDriveImporter } from '../src/onedrive.js';
import { ICloudImporter } from '../src/icloud.js';
import { assertPublicUrl, isPrivateAddress } from '../src/direct-url.js';
import { looksLikeVideo } from '../src/http.js';
import { createImporters, resolveImporter } from '../src/index.js';

describe('provider routing', () => {
  it('routes each host to its own adapter', () => {
    const cases: [string, string][] = [
      ['https://drive.google.com/file/d/1a2b3c4d5e6f/view', 'GOOGLE_DRIVE'],
      ['https://www.dropbox.com/s/abc123/clip.mov?dl=0', 'DROPBOX'],
      ['https://1drv.ms/v/s!AabbCC', 'ONEDRIVE'],
      ['https://contoso-my.sharepoint.com/:v:/g/personal/x/EaBc', 'ONEDRIVE'],
      ['https://www.icloud.com/sharedalbum/#B0abcdef', 'ICLOUD'],
      ['https://cdn.example.com/videos/raw.mov', 'URL'],
    ];
    for (const [url, kind] of cases) {
      expect(resolveImporter(url).kind, url).toBe(kind);
    }
  });

  it('rejects a link from an unsupported scheme', () => {
    expect(() => resolveImporter('ftp://example.com/a.mov')).toThrow(ImportError);
    expect(() => resolveImporter('not a url')).toThrow(/not from a supported service/i);
  });

  it('exposes every provider through one factory', () => {
    const kinds = createImporters().map((importer) => importer.kind);
    expect(kinds).toEqual(['GOOGLE_DRIVE', 'DROPBOX', 'ONEDRIVE', 'ICLOUD', 'URL']);
  });
});

describe('GoogleDriveImporter', () => {
  it('extracts the file id from every link shape Drive produces', () => {
    expect(GoogleDriveImporter.extractFileId('https://drive.google.com/file/d/1AbC_dEf-123456/view?usp=sharing')).toBe(
      '1AbC_dEf-123456',
    );
    expect(GoogleDriveImporter.extractFileId('https://drive.google.com/open?id=1AbC_dEf-123456')).toBe(
      '1AbC_dEf-123456',
    );
    expect(GoogleDriveImporter.extractFileId('https://drive.google.com/uc?id=1AbC_dEf-123456&export=download')).toBe(
      '1AbC_dEf-123456',
    );
  });

  it('returns null for a link with no file id', () => {
    expect(GoogleDriveImporter.extractFileId('https://drive.google.com/drive/my-drive')).toBeNull();
  });

  it('says it is not configured without a token or an API key', () => {
    const previous = process.env['GOOGLE_DRIVE_API_KEY'];
    delete process.env['GOOGLE_DRIVE_API_KEY'];
    try {
      expect(new GoogleDriveImporter().isConfigured()).toBe(false);
      expect(new GoogleDriveImporter().isConfigured({ accessToken: 'x' })).toBe(true);
    } finally {
      if (previous !== undefined) process.env['GOOGLE_DRIVE_API_KEY'] = previous;
    }
  });
});

describe('DropboxImporter', () => {
  it('rewrites a preview link to a direct download', () => {
    expect(DropboxImporter.toDirectUrl('https://www.dropbox.com/s/abc/clip.mov?dl=0')).toContain('dl=1');
    expect(DropboxImporter.toDirectUrl('https://www.dropbox.com/s/abc/clip.mov')).toContain('dl=1');
  });

  it('leaves an already-direct content link alone', () => {
    const direct = 'https://uc123.dl.dropboxusercontent.com/cd/0/get/abc/clip.mov';
    expect(DropboxImporter.toDirectUrl(direct)).toBe(direct);
  });
});

describe('OneDriveImporter', () => {
  it('encodes a share link the way Microsoft Graph documents', () => {
    const shareId = OneDriveImporter.toShareId('https://1drv.ms/v/s!AabbCC');
    expect(shareId.startsWith('u!')).toBe(true);
    expect(shareId).not.toContain('=');
    expect(shareId).not.toContain('+');
    expect(shareId).not.toContain('/');
  });

  it('needs a connected account', () => {
    expect(new OneDriveImporter().isConfigured()).toBe(false);
    expect(new OneDriveImporter().isConfigured({ accessToken: 'x' })).toBe(true);
  });
});

describe('ICloudImporter', () => {
  it('extracts the share token', () => {
    expect(ICloudImporter.extractToken('https://www.icloud.com/sharedalbum/#B0abcdefghij')).toBe('B0abcdefghij');
    expect(ICloudImporter.extractToken('https://www.icloud.com/photos/')).toBeNull();
  });

  it('picks the partition host from the token', () => {
    expect(ICloudImporter.partitionHost('B0abcdef')).toContain('p0-sharedstreams');
    expect(ICloudImporter.partitionHost('B3abcdef')).toContain('p3-sharedstreams');
    // A non-numeric shard falls back to partition 1 rather than building a bad host.
    expect(ICloudImporter.partitionHost('BXabcdef')).toContain('p1-sharedstreams');
  });
});

describe('SSRF protection on direct links', () => {
  it('classifies private and metadata addresses', () => {
    for (const address of [
      '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.4.2', '172.31.255.255',
      '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it('allows genuine public addresses', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '2606:4700::1111']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it('refuses a URL pointing straight at loopback or metadata', async () => {
    await expect(assertPublicUrl('http://127.0.0.1/video.mov')).rejects.toThrow(/private address/i);
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/private address/i);
    await expect(assertPublicUrl('http://[::1]/video.mov')).rejects.toThrow(/private address/i);
  });

  it('refuses non-http schemes', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/http and https/i);
    await expect(assertPublicUrl('gopher://example.com')).rejects.toThrow(/http and https/i);
  });
});

describe('looksLikeVideo', () => {
  it('accepts video MIME types and known containers', () => {
    expect(looksLikeVideo('clip.mov', 'video/quicktime')).toBe(true);
    expect(looksLikeVideo('IMG_4821.MOV', null)).toBe(true);
    expect(looksLikeVideo('clip.mp4', 'application/octet-stream')).toBe(true);
  });

  it('rejects things that are clearly not video', () => {
    expect(looksLikeVideo('notes.pdf', 'application/pdf')).toBe(false);
    expect(looksLikeVideo('photo.jpg', 'image/jpeg')).toBe(false);
    expect(looksLikeVideo('folder', null)).toBe(false);
  });
});
