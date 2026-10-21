import { describe, expect, test } from 'bun:test';
import { CLASS_BEHAVIOUR, RENDERER_CLASSES } from '@relic/format';
import { COVER_KINDS } from '@relic/format/cover';
import {
  BEHAVIOUR_TAILS,
  CARD_DESCRIPTION,
  CLASS_PHRASES,
  CLASS_TITLES,
  COVER_ALT,
  cardCopy,
  FALLBACK_TITLE,
} from '../src/card.ts';

describe('cardCopy', () => {
  test('undefined renderer class returns the unknown-relic pair', () => {
    const copy = cardCopy(undefined);
    expect(copy.title).toBe(FALLBACK_TITLE);
    expect(copy.description).toBe(CARD_DESCRIPTION);
  });

  for (const cls of RENDERER_CLASSES) {
    test(`class ${cls} returns its phrase, matching tail, and fallback title`, () => {
      const copy = cardCopy(cls);
      expect(copy.title).toBe(CLASS_TITLES[cls]);
      expect(copy.title.length).toBeGreaterThan(0);

      const phrase = CLASS_PHRASES[cls];
      expect(phrase.length).toBeGreaterThan(0);
      expect(copy.description.startsWith(phrase)).toBe(true);

      const expectedTail = BEHAVIOUR_TAILS[CLASS_BEHAVIOUR[cls]];
      expect(copy.description).toBe(`${phrase} ${expectedTail}`);
    });
  }

  test('each renderer class gets the tail matching its class behaviour and none of the other tails', () => {
    for (const cls of RENDERER_CLASSES) {
      const copy = cardCopy(cls);
      const behaviour = CLASS_BEHAVIOUR[cls];
      const expectedTail = BEHAVIOUR_TAILS[behaviour];

      expect(copy.description).toContain(expectedTail);
      for (const [otherBehaviour, otherTail] of Object.entries(
        BEHAVIOUR_TAILS
      )) {
        if (otherBehaviour !== behaviour) {
          expect(copy.description).not.toContain(otherTail);
        }
      }
    }
  });

  test('media relic description plays in browser and does not download to device', () => {
    const copy = cardCopy('media');
    expect(copy.description).toContain('It plays in your browser');
    expect(copy.description).not.toContain('downloads to your device');
  });

  test('pdf relic description opens in browser and does not download to device', () => {
    const copy = cardCopy('pdf');
    expect(copy.title).toBe('A PDF relic');
    expect(copy.description).toContain('It opens in your browser');
    expect(copy.description).not.toContain('downloads to your device');
  });

  test('otio relic description plays in browser and does not download to device', () => {
    const copy = cardCopy('otio');
    expect(copy.title).toBe('An OpenTimelineIO relic');
    expect(copy.description).toContain('It plays in your browser');
    expect(copy.description).not.toContain('downloads to your device');
  });
});

describe('COVER_ALT', () => {
  test('accounts for every CoverKind', () => {
    for (const kind of COVER_KINDS) {
      expect(COVER_ALT[kind]).toBeDefined();
      expect(typeof COVER_ALT[kind]).toBe('string');
      expect(COVER_ALT[kind].length).toBeGreaterThan(0);
    }
  });

  test('matches the exact phrases required by the contract', () => {
    expect(COVER_ALT.markdown).toBe(
      'The opening of this Markdown document, as it renders.'
    );
    expect(COVER_ALT.code).toBe(
      'The first lines of this code file, as they render.'
    );
    expect(COVER_ALT.html).toBe('The top of this HTML page, as it renders.');
    expect(COVER_ALT.jsx).toBe('The top of this JSX component, as it renders.');
    expect(COVER_ALT.image).toBe('This image, cropped to the card.');
    expect(COVER_ALT.pdf).toBe("The top of this PDF's first page.");
    expect(COVER_ALT.video).toBe(
      'A frame from the opening seconds of this video.'
    );
    expect(COVER_ALT['audio-artwork']).toBe(
      'The artwork embedded in this audio file.'
    );
    expect(COVER_ALT['audio-waveform']).toBe(
      'The waveform of this audio file.'
    );
    expect(COVER_ALT.archive).toBe('The list of files inside this archive.');
  });
});
