import { describe, expect, test } from 'bun:test';
import {
  CONTENTS_LABEL,
  INSECURE_ADVICE,
  INSECURE_DETAIL,
  INSECURE_TITLE,
  LOAD_EXPLANATION,
  LOAD_OPENING,
  MalformedContainerError,
  NOSCRIPT_DETAIL,
  NOSCRIPT_TITLE,
  PHASE_DECRYPTING,
  PHASE_FETCHING,
  PHASE_RENDERING,
  POLICY_LINK_LABEL,
  REPORT_LINK_LABEL,
  RelicFormatError,
  TRANSFER_LABEL,
  TransferIncompleteError,
  TruncatedContainerError,
} from '../src/index.ts';

describe('load copy constants and format errors', () => {
  test('copy constants match spec values verbatim', () => {
    expect(LOAD_EXPLANATION).toBe(
      "The file in this link is decrypted in your browser. The key is in the link and your browser never sends it to Relic's servers."
    );
    expect(LOAD_OPENING).toBe('Opening…');
    expect(PHASE_FETCHING).toBe('Fetching');
    expect(PHASE_DECRYPTING).toBe('Decrypting');
    expect(PHASE_RENDERING).toBe('Rendering');
    expect(TRANSFER_LABEL).toBe('TRANSFER');
    expect(CONTENTS_LABEL).toBe('CONTENTS');
    expect(REPORT_LINK_LABEL).toBe('Report this relic');
    expect(POLICY_LINK_LABEL).toBe('How Relic handles your data');
    expect(NOSCRIPT_TITLE).toBe('This page needs JavaScript to open a relic.');
    expect(NOSCRIPT_DETAIL).toBe(
      "Relic decrypts the file in your browser, so with JavaScript off there is nothing here to decrypt it with. Nothing has been sent to Relic's servers and the key in this link has not been used, so the link still works in a browser that runs JavaScript."
    );
    expect(INSECURE_TITLE).toBe(
      'This page did not arrive over a secure connection'
    );
    expect(INSECURE_DETAIL).toBe(
      'Browsers only allow the decryption Relic uses on a secure connection, and this one is not on it. Relic serves every relic over HTTPS, so something between this browser and Relic changed that. On a company, campus, or hotel network it is usually a device that inspects traffic.'
    );
    expect(INSECURE_ADVICE).toBe(
      'Opening the same link on a different network is the thing most likely to work. Reloading on this one will not.'
    );
  });

  test('TransferIncompleteError is instanceof RelicFormatError and carries fields', () => {
    const err = new TransferIncompleteError(100, 500);
    expect(err).toBeInstanceOf(RelicFormatError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TransferIncompleteError');
    expect(err.receivedBytes).toBe(100);
    expect(err.expectedBytes).toBe(500);
    expect(err.message).toContain('100');
    expect(err.message).toContain('500');
  });

  test('TruncatedContainerError is instanceof MalformedContainerError and RelicFormatError', () => {
    const err = new TruncatedContainerError('truncated');
    expect(err).toBeInstanceOf(MalformedContainerError);
    expect(err).toBeInstanceOf(RelicFormatError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TruncatedContainerError');
  });
});
