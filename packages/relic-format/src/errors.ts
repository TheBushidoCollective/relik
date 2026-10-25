/**
 * Every refusal the format can produce, as a distinguishable type.
 *
 * `spec/format.md` 3.5 forbids one conflation in particular: a decrypt
 * failure must never be reported as "wrong key". Tampering, truncation, and
 * a genuinely wrong key produce the identical symptom, so `DecryptFailed`
 * carries no cause and callers must not invent one.
 */

export class RelicFormatError extends Error {
  override readonly name: string = 'RelicFormatError';
}

/** The fragment's version marker names a version this build does not know. */
export class UnknownVersionError extends RelicFormatError {
  override readonly name = 'UnknownVersionError';
  constructor(readonly marker: string) {
    super(`unknown relic format version: ${JSON.stringify(marker)}`);
  }
}

/** The fragment is absent, too short, or not the shape 2.1 fixes. */
export class MalformedFragmentError extends RelicFormatError {
  override readonly name = 'MalformedFragmentError';
}

/** The RFC 8188 header is unreadable, or violates a rule the format adds. */
export class MalformedContainerError extends RelicFormatError {
  // Widened rather than a literal, because three subclasses narrow it.
  override readonly name: string = 'MalformedContainerError';
}

/**
 * `keyid` is present. `spec/format.md` 3.4 makes `idlen == 0` a hard
 * invariant and requires refusal after the fetch, because the header sits in
 * the object's first bytes and nothing can be checked before they arrive.
 */
export class KeyIdPresentError extends MalformedContainerError {
  override readonly name = 'KeyIdPresentError';
  constructor(readonly idlen: number) {
    super(`container sets keyid (idlen=${idlen}); it must be 0`);
  }
}

/**
 * The envelope header inside the AEAD names a different version than the
 * fragment marker did. `spec/format.md` 3.7 requires refusal: it means a
 * mangled fragment prefix or a substituted object.
 */
export class VersionMismatchError extends MalformedContainerError {
  override readonly name = 'VersionMismatchError';
  constructor(
    readonly fragmentVersion: number,
    readonly envelopeVersion: number
  ) {
    super(
      `envelope version ${envelopeVersion} disagrees with fragment ` +
        `version ${fragmentVersion}`
    );
  }
}

/**
 * The envelope header did not parse exactly. `spec/format.md` 3.1 requires a
 * strict parser: unknown fields are refused rather than ignored, which here
 * means any byte left over after the declared structure is a refusal.
 */
export class StrictParseError extends MalformedContainerError {
  override readonly name = 'StrictParseError';
}

/** The container is truncated: missing its final delimiter-2 record or declared content bytes. */
export class TruncatedContainerError extends MalformedContainerError {
  override readonly name = 'TruncatedContainerError';
}

/** The stream closed or errored before reaching the declared object length. */
export class TransferIncompleteError extends RelicFormatError {
  override readonly name = 'TransferIncompleteError';
  constructor(readonly receivedBytes: number, readonly expectedBytes: number) {
    super(`transfer incomplete: received ${receivedBytes} of ${expectedBytes} bytes`);
  }
}

/**
 * An AEAD tag did not verify.
 *
 * Deliberately carries no cause. Per `spec/format.md` 3.5 a wrong key, a
 * truncated transfer, and a tampered `salt` or `rs` are indistinguishable
 * from this side, and the viewer must not claim otherwise.
 */
export class DecryptFailedError extends RelicFormatError {
  override readonly name = 'DecryptFailedError';
  constructor(readonly recordSeq: number) {
    super(`record ${recordSeq} failed authentication`);
  }
}

/** The content exceeds the published cap. */
export class ContentTooLargeError extends RelicFormatError {
  override readonly name = 'ContentTooLargeError';
  constructor(
    readonly declaredBytes: number,
    readonly limitBytes: number
  ) {
    super(`content is ${declaredBytes} bytes, over the ${limitBytes} cap`);
  }
}

/**
 * A comment's plaintext did not parse exactly.
 *
 * Same discipline as `StrictParseError` one layer down: `spec/format.md`
 * refuses unknown fields rather than ignoring them, so an extension to the
 * comment envelope arrives as a deliberate change instead of being swallowed
 * by a parser that shrugged.
 */
export class MalformedCommentError extends RelicFormatError {
  override readonly name = 'MalformedCommentError';
}

/**
 * A comment's AEAD tag did not verify.
 *
 * Carries no cause, for the reason `DecryptFailedError` carries none: a wrong
 * key, a truncated value, and a tampered nonce are indistinguishable from
 * this side, and a caller must not claim otherwise to a reader.
 */
export class CommentDecryptFailedError extends RelicFormatError {
  override readonly name = 'CommentDecryptFailedError';
  constructor() {
    super('the comment failed authentication');
  }
}

/** A comment field exceeds its cap. */
export class CommentTooLargeError extends RelicFormatError {
  override readonly name = 'CommentTooLargeError';
  constructor(
    readonly field:
      | 'body'
      | 'display_name'
      | 'anchor'
      | 'addresses'
      | 'ciphertext',
    readonly declaredBytes: number,
    readonly limitBytes: number
  ) {
    super(
      `comment ${field} is ${declaredBytes} ${field === 'ciphertext' ? 'characters' : 'bytes of UTF-8'}, over the ` +
        `${limitBytes} cap`
    );
  }
}

/**
 * A mnemonic phrase fails word count, contains an unknown word or prefix,
 * has an invalid checksum, or decodes to an integer outside the 128-bit key range.
 */
export class InvalidMnemonicError extends RelicFormatError {
  override readonly name = 'InvalidMnemonicError';
  readonly wordCount?: number | undefined;

  constructor(
    readonly reason: 'count' | 'unknown_word' | 'range' | 'checksum',
    readonly wordIndex?: number | undefined,
    message?: string,
    wordCount?: number | undefined
  ) {
    super(
      message ??
        (reason === 'count'
          ? `mnemonic must contain exactly 12 words, got ${wordCount ?? wordIndex ?? 'unknown'}`
          : reason === 'unknown_word'
            ? `unknown mnemonic word at index ${wordIndex}`
            : reason === 'checksum'
              ? 'invalid mnemonic checksum'
              : 'mnemonic value exceeds 128-bit key range')
    );
    this.wordCount = wordCount ?? (reason === 'count' ? wordIndex : undefined);
  }
}
