/**
 * Semantic check that the sham build differs from production in exactly one place: the primer's
 * `element.muted = false` becomes `true`. Pure: it takes the built bytes and compares them.
 *
 * Pairing. Bun names hashed chunks chunk-<hash>.js and writes the same content hashes as bare
 * strings in main.js (its id array, including the entry's own id). A sham build's hashes differ
 * from production's, so they are paired, not compared:
 *   - chunk outputs are paired by walking the reference graph from main.js. The k-th graph
 *     reference in production must correspond to the k-th in the sham, and pairs are followed
 *     recursively. Every output must be reached from main.js, on both sides.
 *   - each paired chunk gives a hash pair, and the entry id array gives one more (main.js's own
 *     hash). A hash must pair with the same partner everywhere it appears.
 * Only after pairing is the sham's text rewritten: each hash that the pairing verified is replaced
 * with its production partner, same length. Then the bytes are compared. Exactly one site must
 * remain, and it must be the primer mute.
 *
 * viewer.js is a deliberate byte-identical copy of main.js. It is excluded from pairing only when
 * its bytes equal main.js in that build. Its content is then covered by main.js, which is compared.
 *
 * The check fails closed. Negative controls run in the same call: production against itself, and
 * a one-byte tamper on either side, must each be rejected.
 */

/** A graph reference as the bundler writes it: ./name.js in import() and worker URLs. */
const REFERENCE = /\.\/([A-Za-z0-9_.-]+\.js)/g;
/** A Bun content hash: exactly 8 alphanumerics, as a whole token. */
const HASH = /(?<![A-Za-z0-9])[A-Za-z0-9]{8}(?![A-Za-z0-9])/g;
const CHUNK_NAME = /^chunk-([A-Za-z0-9]{8})\.js$/;
/** The entry's id array: its own hash is the first element, after import.meta.url. */
const ENTRY_ID = /import\.meta\.url,\["([A-Za-z0-9]{8})"/;

/** Entry names that are deliberate byte-identical copies of main.js. */
export const ENTRY_ALIASES = ['viewer.js'] as const;

export interface BundleSite {
  /** Production output name the difference is in. */
  readonly file: string;
  readonly index: number;
  readonly production: string;
  readonly sham: string;
  /** Up to 12 characters before the site, from production, for diagnosis. */
  readonly before: string;
}

export interface BundleDiff {
  /** Differences that are not single-character sites: unpaired outputs, pairing conflicts. */
  readonly structural: string[];
  readonly sites: BundleSite[];
}

export interface ChunkPairing {
  /** Sham output name to production output name. */
  readonly toProduction: ReadonlyMap<string, string>;
  /** Production output name to sham output name. */
  readonly toSham: ReadonlyMap<string, string>;
  readonly structural: string[];
}

/** Bytes as text, one character per byte. Lossless for these ASCII-dominant bundles. */
export function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}

function references(text: string): string[] {
  return [...text.matchAll(REFERENCE)].map((match) => match[1]!);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The build without verified entry aliases, and which aliases were removed. */
export function stripEntryAliases(files: ReadonlyMap<string, Uint8Array>): {
  files: Map<string, Uint8Array>;
  aliases: string[];
} {
  const main = files.get('main.js');
  const out = new Map(files);
  const aliases: string[] = [];
  for (const alias of ENTRY_ALIASES) {
    const bytes = files.get(alias);
    if (bytes && main && sameBytes(bytes, main)) {
      out.delete(alias);
      aliases.push(alias);
    }
  }
  return { files: out, aliases };
}

/**
 * Pairs each sham output with its production counterpart by walking the reference graph from
 * main.js. Names are never compared. Every output on each side must be reached.
 */
export function pairChunks(
  production: ReadonlyMap<string, Uint8Array>,
  sham: ReadonlyMap<string, Uint8Array>
): ChunkPairing {
  const structural: string[] = [];
  const toProduction = new Map<string, string>();
  const toSham = new Map<string, string>();
  if (!production.has('main.js') || !sham.has('main.js')) {
    structural.push('main.js is missing from a build');
    return { toProduction, toSham, structural };
  }
  toProduction.set('main.js', 'main.js');
  toSham.set('main.js', 'main.js');
  const queue: Array<[string, string]> = [['main.js', 'main.js']];
  for (let next = queue.shift(); next; next = queue.shift()) {
    const [p, s] = next;
    const productionRefs = references(latin1(production.get(p)!));
    const shamRefs = references(latin1(sham.get(s)!));
    if (productionRefs.length !== shamRefs.length) {
      structural.push(
        `${s} references ${shamRefs.length} file(s); production ${p} references ${productionRefs.length}`
      );
      continue;
    }
    productionRefs.forEach((pr, i) => {
      const sr = shamRefs[i]!;
      if (!production.has(pr) || !sham.has(sr)) {
        if (pr !== sr)
          structural.push(
            `${s}: reference ${sr} is not the production reference ${pr}`
          );
        return;
      }
      const pairedProduction = toProduction.get(sr);
      const pairedSham = toSham.get(pr);
      if (pairedProduction === undefined && pairedSham === undefined) {
        toProduction.set(sr, pr);
        toSham.set(pr, sr);
        queue.push([pr, sr]);
      } else if (pairedProduction !== pr || pairedSham !== sr) {
        structural.push(
          `${s}: ${sr} and ${pr} disagree with an earlier pairing (${pairedProduction ?? 'none'} / ${pairedSham ?? 'none'})`
        );
      }
    });
  }
  for (const name of production.keys())
    if (!toSham.has(name))
      structural.push(
        `production ${name} is not reached from main.js in the sham build`
      );
  for (const name of sham.keys())
    if (!toProduction.has(name))
      structural.push(`sham ${name} is not reached from main.js in production`);
  return { toProduction, toSham, structural };
}

/**
 * Hash pairs: each paired chunk's hash, and main.js's own id from the entry array. A hash must pair
 * with one partner only, in both directions. Returns sham hash to production hash.
 */
export function pairHashes(
  production: ReadonlyMap<string, Uint8Array>,
  sham: ReadonlyMap<string, Uint8Array>,
  pairing: ChunkPairing
): { toProduction: Map<string, string>; structural: string[] } {
  const structural: string[] = [];
  const toProduction = new Map<string, string>();
  const toSham = new Map<string, string>();
  const add = (shamHash: string, productionHash: string, where: string) => {
    const known = toProduction.get(shamHash);
    const back = toSham.get(productionHash);
    if (known === undefined && back === undefined) {
      toProduction.set(shamHash, productionHash);
      toSham.set(productionHash, shamHash);
    } else if (known !== productionHash || back !== shamHash) {
      structural.push(
        `${where}: hash ${shamHash} -> ${productionHash} conflicts with an earlier pairing`
      );
    }
  };
  for (const [shamName, productionName] of pairing.toProduction) {
    // The entry's hash comes from its id array below, not from its file name.
    if (shamName === 'main.js') continue;
    const s = CHUNK_NAME.exec(shamName);
    const p = CHUNK_NAME.exec(productionName);
    if (!s || !p) {
      structural.push(
        `output ${shamName} / ${productionName} is not chunk-<8 chars>.js`
      );
      continue;
    }
    add(s[1]!, p[1]!, shamName);
  }
  const sid = ENTRY_ID.exec(latin1(sham.get('main.js')!));
  const pid = ENTRY_ID.exec(latin1(production.get('main.js')!));
  if (!sid || !pid)
    structural.push(
      'main.js has no entry id array (import.meta.url,["<hash>"...) in a build'
    );
  else add(sid[1]!, pid[1]!, 'main.js');
  return { toProduction, structural };
}

/** Replaces each verified sham hash token with its production partner. Same length. */
function normalizeHashes(
  text: string,
  toProduction: ReadonlyMap<string, string>
): string {
  return text.replace(HASH, (token) => toProduction.get(token) ?? token);
}

function describe(site: BundleSite): string {
  return `${site.file}@${site.index} production ${JSON.stringify(site.before + site.production)} sham ${JSON.stringify(site.before + site.sham)}`;
}

/** Compares two builds after pairing outputs and hashes. Each map is output basename to bytes. */
export function diffBundles(
  production: ReadonlyMap<string, Uint8Array>,
  sham: ReadonlyMap<string, Uint8Array>
): BundleDiff {
  const prod = stripEntryAliases(production);
  const shamSide = stripEntryAliases(sham);
  const structural: string[] = [];
  for (const alias of ENTRY_ALIASES)
    if (prod.aliases.includes(alias) !== shamSide.aliases.includes(alias))
      structural.push(
        `${alias} is a byte-identical alias of main.js in only one build`
      );
  const pairing = pairChunks(prod.files, shamSide.files);
  structural.push(...pairing.structural);
  if (structural.length) return { structural, sites: [] };
  const hashes = pairHashes(prod.files, shamSide.files, pairing);
  structural.push(...hashes.structural);
  if (structural.length) return { structural, sites: [] };

  const sites: BundleSite[] = [];
  for (const [name, bytes] of prod.files) {
    const shamName = pairing.toSham.get(name)!;
    const p = latin1(bytes);
    const s = normalizeHashes(
      latin1(shamSide.files.get(shamName)!),
      hashes.toProduction
    );
    if (p.length !== s.length) {
      structural.push(
        `${name}: length ${p.length} != ${s.length} after pairing with ${shamName}`
      );
      continue;
    }
    for (let i = 0; i < p.length; i++) {
      if (p[i] !== s[i])
        sites.push({
          file: name,
          index: i,
          production: p[i]!,
          sham: s[i]!,
          before: p.slice(Math.max(0, i - 12), i),
        });
    }
  }
  return { structural, sites };
}

/**
 * Failures of the sham build against production. Empty means the sham differs from production in
 * exactly one site, and that site is the primer's mute: production `1` (false) becomes sham `0`
 * (true), after `.muted=!`.
 */
export function verifyShamSites(
  production: ReadonlyMap<string, Uint8Array>,
  sham: ReadonlyMap<string, Uint8Array>
): string[] {
  const diff = diffBundles(production, sham);
  const failures = [...diff.structural];
  if (diff.sites.length !== 1) {
    failures.push(
      `sham differs from production at ${diff.sites.length} site(s), expected exactly 1: ${diff.sites.slice(0, 5).map(describe).join('; ')}`
    );
    return failures;
  }
  const [site] = diff.sites;
  if (
    site!.production !== '1' ||
    site!.sham !== '0' ||
    !/\.muted=!$/.test(site!.before)
  )
    failures.push(
      `the one sham site is not the primer mute (expected .muted=!1 to .muted=!0): ${describe(site!)}`
    );
  return failures;
}

/** Returns a copy of the builds with one byte of the named file changed. */
export function tamperOneByte(
  files: ReadonlyMap<string, Uint8Array>,
  name: string,
  index: number
): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const [key, bytes] of files) out.set(key, new Uint8Array(bytes));
  const target = out.get(name);
  if (!target) throw new Error(`tamper target ${name} is not in the build`);
  target[index] = (target[index] ?? 0) ^ 0x01;
  return out;
}

/**
 * Negative controls for verifyShamSites. Each must be rejected. A control that passes means the
 * comparison cannot tell a real sham from a no-op or a corrupted build, so the proof fails.
 */
export function verifyShamControls(
  production: ReadonlyMap<string, Uint8Array>,
  sham: ReadonlyMap<string, Uint8Array>,
  entryName = 'main.js'
): string[] {
  const failures: string[] = [];
  if (verifyShamSites(production, production).length === 0)
    failures.push('control: production compared with itself passed as a sham');
  if (
    verifyShamSites(production, tamperOneByte(production, entryName, 0))
      .length === 0
  )
    failures.push('control: a one-byte tamper of production passed as a sham');
  if (
    verifyShamSites(production, tamperOneByte(sham, entryName, 0)).length === 0
  )
    failures.push('control: a one-byte tamper of the sham passed as a sham');
  return failures;
}
