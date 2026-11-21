import { expect, test } from 'bun:test';
import { prepareBrowserZip } from '../src/browser-zip-source.ts';

test('names an archive that the browser cannot read', async () => {
  const file = new File([new Uint8Array(22)], 'cloud.zip');
  Object.defineProperty(file, 'slice', {
    value: () => {
      throw new Error('not available');
    },
  });
  await expect(prepareBrowserZip(file)).rejects.toThrow(
    'Could not read cloud.zip'
  );
});
