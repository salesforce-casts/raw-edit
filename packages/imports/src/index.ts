import { ImportError, type CloudImportProvider } from '@rawedit/core';
import { GoogleDriveImporter } from './google-drive.js';
import { DropboxImporter } from './dropbox.js';
import { OneDriveImporter } from './onedrive.js';
import { ICloudImporter } from './icloud.js';
import { DirectUrlImporter } from './direct-url.js';

export { GoogleDriveImporter } from './google-drive.js';
export { DropboxImporter } from './dropbox.js';
export { OneDriveImporter } from './onedrive.js';
export { ICloudImporter } from './icloud.js';
export { DirectUrlImporter, assertPublicUrl, isPrivateAddress } from './direct-url.js';
export { looksLikeVideo, filenameFrom } from './http.js';

/**
 * Order matters: the named providers claim their own hosts first, and the direct-URL
 * adapter is the catch-all. Adding a provider is one entry here plus its adapter.
 */
export function createImporters(): CloudImportProvider[] {
  return [
    new GoogleDriveImporter(),
    new DropboxImporter(),
    new OneDriveImporter(),
    new ICloudImporter(),
    new DirectUrlImporter(),
  ];
}

export function resolveImporter(
  url: string,
  importers: readonly CloudImportProvider[] = createImporters(),
): CloudImportProvider {
  const match = importers.find((importer) => importer.canHandle(url));
  if (!match) {
    throw new ImportError(
      'That link is not from a supported service. Paste a Google Drive, Dropbox, OneDrive or iCloud link, or a direct https link to the file.',
      'UNSUPPORTED_URL',
    );
  }
  return match;
}
