/**
 * The unfurl card's copy, and the only place it is written.
 *
 * What the card carries: the relic's coarse renderer class, and the
 * publisher-declared title when there is one. The publishing client defaults
 * that title to the source filename, so the card can name a file, and a
 * publisher who declines a title removes it. The class is not declinable,
 * because it is derived from the bytes rather than chosen.
 *
 * What it never carries: the contents, the envelope header's authoritative
 * filename and declared mimetype, which stay inside the AEAD, and anything
 * finer than the ten-value class.
 * Why the class is allowed here at all. It is the coarse category the frame
 * already concedes to the operator on the grant, so the card is a new
 * audience for a field the service has always held rather than a new field.
 * What the recipient gets for it is the thing the card exists to give them:
 * on an unfamiliar domain, knowing a link holds an archive or an HTML page
 * is the difference between a decision and a guess. The cost, and the
 * boundary that replaces the class's former absence from this origin, is
 * recorded in `spec/format.md` 3.6.
 *
 * How the closing sentence is chosen. The tail describes what the viewer
 * actually does when a recipient opens the link: content on the page, a
 * player in the browser, or a file downloaded to the device. The authority
 * for that description is CLASS_BEHAVIOUR from @relic/format, not
 * isRenderable. A previous revision chose the tail using isRenderable, which
 * represents telemetry vocabulary for the success metric rather than viewer
 * behavior. Because media sits outside RENDERABLE_CLASSES, that choice made
 * the card falsely claim that audio and video relics download to your
 * device when the viewer actually plays them in your browser. Keying on
 * CLASS_BEHAVIOUR ensures the card tells the truth about viewer behavior.
 */

import {
  CLASS_BEHAVIOUR,
  type ClassBehaviour,
  type RendererClass,
} from '@relic/format';
import type { CoverKind } from '@relic/format/cover';
export const CLASS_PHRASES: Record<RendererClass, string> = {
  markdown: 'A Markdown document.',
  code: 'A source code file.',
  html: 'An HTML page.',
  jsx: 'A JSX component.',
  image: 'An image.',
  pdf: 'A PDF document.',
  media: 'An audio or video file.',
  archive: 'An archive.',
  binary: 'A binary file.',
  otio: 'An OpenTimelineIO timeline.',
};

export const CLASS_TITLES: Record<RendererClass, string> = {
  markdown: 'A Markdown relic',
  code: 'A code relic',
  html: 'An HTML relic',
  jsx: 'A JSX relic',
  image: 'An image relic',
  pdf: 'A PDF relic',
  media: 'A media relic',
  archive: 'An archive relic',
  binary: 'A binary relic',
  otio: 'An OpenTimelineIO relic',
};

export const BEHAVIOUR_TAILS: Record<ClassBehaviour, string> = {
  renders:
    'It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.',
  plays:
    'It plays in your browser, and only someone holding the whole link, including the part after the #, can open it.',
  downloads:
    'It downloads to your device, and only someone holding the whole link, including the part after the #, can open it.',
};
export const FALLBACK_TITLE = 'A relic';

export const CARD_DESCRIPTION =
  'An encrypted file. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.';

export interface CardCopy {
  readonly title: string;
  readonly description: string;
}

/**
 * Return the card title and description for a relic.
 *
 * When the renderer class is undefined (the relic is unknown, expired,
 * tombstoned, or failed to load), the copy falls back to the constant
 * encrypted-file card.
 */
export function cardCopy(rendererClass: RendererClass | undefined): CardCopy {
  if (rendererClass === undefined) {
    return {
      title: FALLBACK_TITLE,
      description: CARD_DESCRIPTION,
    };
  }

  const phrase = CLASS_PHRASES[rendererClass];
  const tail = BEHAVIOUR_TAILS[CLASS_BEHAVIOUR[rendererClass]];
  return {
    title: CLASS_TITLES[rendererClass],
    description: `${phrase} ${tail}`,
  };
}

export const COVER_ALT: Readonly<Record<CoverKind, string>> = {
  markdown: 'The opening of this Markdown document, as it renders.',
  code: 'The first lines of this code file, as they render.',
  html: 'The top of this HTML page, as it renders.',
  jsx: 'The top of this JSX component, as it renders.',
  image: 'This image, cropped to the card.',
  pdf: "The top of this PDF's first page.",
  video: 'A frame from the opening seconds of this video.',
  'audio-artwork': 'The artwork embedded in this audio file.',
  'audio-waveform': 'The waveform of this audio file.',
  archive: 'The list of files inside this archive.',
};
