import { decodeXmlBytes, scanForbiddenDtd } from '@relic/format/xml';

const MAX_XML_PART_BYTES = 16 * 1024 * 1024;
const MAX_XML_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_XML_UNITS = 250_000;
const MAX_XML_DEPTH = 256;
const MAX_XML_ATTRIBUTES = 256;

export class DocxLimitError extends Error {
  readonly code = 'RELIC_DOCX_TOO_LARGE';
}

const whitespace = (char: string | undefined): boolean =>
  char === ' ' || char === '\t' || char === '\n' || char === '\r';

/** Bound XML reads before docx-preview invokes the browser parser. */
export class XmlReadBudget {
  private bytes = 0;
  private units = 0;
  omittedEmbeddedContent = false;

  constructor(
    private readonly maxPartBytes = MAX_XML_PART_BYTES,
    private readonly maxTotalBytes = MAX_XML_TOTAL_BYTES,
    private readonly maxUnits = MAX_XML_UNITS
  ) {}

  read(bytes: Uint8Array): string {
    if (
      bytes.byteLength > this.maxPartBytes ||
      bytes.byteLength > this.maxTotalBytes - this.bytes
    )
      throw new DocxLimitError('DOCX XML byte limit exceeded');
    this.bytes += bytes.byteLength;
    const text = decodeXmlBytes(bytes, { fatal: true });
    if (scanForbiddenDtd(text, 'docx')) throw new Error('Invalid DOCX XML');
    this.inspect(text);
    return text;
  }

  private charge(): void {
    if (++this.units > this.maxUnits)
      throw new DocxLimitError('DOCX XML structure limit exceeded');
  }

  private inspect(text: string): void {
    let at = 0;
    let depth = 0;
    while (at < text.length) {
      if (text[at] !== '<') {
        this.charge();
        const end = text.indexOf('<', at);
        at = end < 0 ? text.length : end;
        continue;
      }
      if (text.startsWith('<!--', at)) {
        this.charge();
        const end = text.indexOf('-->', at + 4);
        if (end < 0) throw new Error('Invalid DOCX XML comment');
        at = end + 3;
        continue;
      }
      if (text.startsWith('<![CDATA[', at)) {
        this.charge();
        const end = text.indexOf(']]>', at + 9);
        if (end < 0) throw new Error('Invalid DOCX XML CDATA');
        at = end + 3;
        continue;
      }
      if (text.startsWith('<?', at)) {
        this.charge();
        const end = text.indexOf('?>', at + 2);
        if (end < 0) throw new Error('Invalid DOCX XML instruction');
        at = end + 2;
        continue;
      }
      if (text.startsWith('</', at)) {
        const end = text.indexOf('>', at + 2);
        if (end < 0 || --depth < 0) throw new Error('Invalid DOCX XML close');
        at = end + 1;
        continue;
      }
      if (text.startsWith('<!', at))
        throw new Error('Invalid DOCX XML declaration');
      this.charge();
      if (depth >= MAX_XML_DEPTH)
        throw new DocxLimitError('DOCX XML depth limit exceeded');
      at++;
      const start = at;
      while (
        at < text.length &&
        !whitespace(text[at]) &&
        text[at] !== '/' &&
        text[at] !== '>'
      )
        at++;
      if (at === start) throw new Error('Invalid DOCX XML element');
      const name = text.slice(start, at);
      if (name.slice(name.lastIndexOf(':') + 1) === 'altChunk')
        this.omittedEmbeddedContent = true;
      let attributes = 0;
      let closed = false;
      while (at < text.length) {
        while (whitespace(text[at])) at++;
        if (text[at] === '>') {
          at++;
          depth++;
          closed = true;
          break;
        }
        if (text[at] === '/' && text[at + 1] === '>') {
          at += 2;
          closed = true;
          break;
        }
        const attr = at;
        while (
          at < text.length &&
          !whitespace(text[at]) &&
          text[at] !== '=' &&
          text[at] !== '/' &&
          text[at] !== '>'
        )
          at++;
        if (at === attr) throw new Error('Invalid DOCX XML attribute');
        if (++attributes > MAX_XML_ATTRIBUTES)
          throw new DocxLimitError('DOCX XML attribute limit exceeded');
        this.charge();
        while (whitespace(text[at])) at++;
        if (text[at++] !== '=') throw new Error('Invalid DOCX XML attribute');
        while (whitespace(text[at])) at++;
        const quote = text[at++];
        if (quote !== '"' && quote !== "'")
          throw new Error('Invalid DOCX XML attribute');
        const end = text.indexOf(quote, at);
        if (end < 0) throw new Error('Invalid DOCX XML attribute');
        at = end + 1;
      }
      if (!closed) throw new Error('Invalid DOCX XML element');
    }
    if (depth !== 0) throw new Error('Invalid DOCX XML nesting');
  }
}
