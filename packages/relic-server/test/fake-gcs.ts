import { gcsStore } from '../src/gcsstore.ts';
import type { RelicStore } from '../src/store.ts';

export interface FakeObject {
  readonly body: string;
  readonly generation: number;
  /** Set only by a multipart upload that carried one, as GCS records it. */
  readonly customTime?: string;
  readonly metageneration?: number;
}

/**
 * A fake of the slice of the Cloud Storage JSON API the store depends on.
 *
 * Every write bumps a generation, and a write carrying `ifGenerationMatch`
 * fails with 412 when it no longer matches, which is the one behaviour
 * correctness rests on. Multipart uploads are parsed the way GCS documents
 * them: the first part is the object metadata (`name`, `customTime`), the
 * second is the payload. A media upload carries no metadata at all.
 */
export interface FakeGcs {
  fetch: typeof globalThis.fetch;
  readonly objects: Map<string, FakeObject>;
  /** Every request the store has made, in order, as the fake received it. */
  readonly requests: { readonly url: string; readonly init: RequestInit }[];
  beforeNextUpload(name: string, hook: () => Promise<void>): void;
  /** Runs after a create-only upload is refused, before the response returns. */
  afterNextCreateConflict(name: string, hook: () => Promise<void>): void;
  /** Runs before a generation-checked replacement is applied. */
  beforeNextReplace(name: string, hook: () => Promise<void>): void;
  beforeNextDelete(name: string, hook: () => Promise<void>): void;
  /** `times: -1` means every write, for modelling permanent contention. */
  contendOn(name: string, times: number): void;
}

/** Splits a multipart/related body into its metadata and payload parts. */
function parseMultipart(
  body: string,
  contentType: string
): {
  readonly name: string;
  readonly customTime?: string;
  readonly payload: string;
} {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
  if (boundary === undefined) {
    throw new Error('multipart upload without a boundary');
  }
  const sections = body.split(`--${boundary}`);
  const parts = sections.slice(1, -1).map((section) => {
    const trimmed = section.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const headerEnd = trimmed.indexOf('\r\n\r\n');
    if (headerEnd === -1) throw new Error('multipart part without headers');
    return trimmed.slice(headerEnd + 4);
  });
  if (parts.length !== 2 || !body.endsWith(`--${boundary}--\r\n`)) {
    throw new Error(
      `expected a metadata part and a payload part, got ${parts.length}`
    );
  }
  const metadata = JSON.parse(parts[0] as string) as {
    name: string;
    customTime?: string;
  };
  return {
    name: metadata.name,
    ...(metadata.customTime === undefined
      ? {}
      : { customTime: metadata.customTime }),
    payload: parts[1] as string,
  };
}

export function fakeGcs(): FakeGcs {
  const objects = new Map<string, FakeObject>();
  const media = new Map<string, Uint8Array>();
  const requests: { url: string; init: RequestInit }[] = [];
  let nextGeneration = 1;
  /**
   * Names to advance one generation just before the next write to them, which
   * is what a competing instance looks like from in here.
   *
   * Modelled by mutating the map directly rather than by driving a second
   * store, because a second store issues writes of its own and those would
   * re-enter this hook and recurse. An absent object is created empty, which
   * is what a competing create looks like.
   */
  const bumps = new Map<string, number>();
  const uploadHooks = new Map<string, () => Promise<void>>();
  const createConflictHooks = new Map<string, () => Promise<void>>();
  const replaceHooks = new Map<string, () => Promise<void>>();
  const deleteHooks = new Map<string, () => Promise<void>>();

  const competingIncrement = (name: string): void => {
    const remaining = bumps.get(name);
    if (remaining === undefined || remaining === 0) return;
    if (remaining > 0) bumps.set(name, remaining - 1);

    const existing = objects.get(name);
    if (existing === undefined) {
      objects.set(name, {
        body: JSON.stringify({}),
        generation: nextGeneration++,
      });
      return;
    }

    const parsed = JSON.parse(existing.body) as Record<string, unknown>;
    if ('mintsUsed' in parsed) {
      parsed['mintsUsed'] = (Number(parsed['mintsUsed']) || 0) + 1;
    }
    if ('attempts' in parsed) {
      parsed['attempts'] = (Number(parsed['attempts']) || 0) + 1;
    }
    objects.set(name, {
      body: JSON.stringify(parsed),
      generation: nextGeneration++,
      ...(existing.customTime === undefined
        ? {}
        : { customTime: existing.customTime }),
    });
  };

  const handler = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    requests.push({ url: url.toString(), init: init ?? {} });

    if (url.pathname.startsWith('/upload/')) {
      const precondition = url.searchParams.get('ifGenerationMatch');
      const uploadType = url.searchParams.get('uploadType');

      let name: string;
      let payload: string | Uint8Array;
      let customTime: string | undefined;
      if (uploadType === 'multipart') {
        const contentType =
          new Headers(init?.headers).get('content-type') ?? '';
        const parsed = parseMultipart(String(init?.body ?? ''), contentType);
        name = parsed.name;
        payload = parsed.payload;
        customTime = parsed.customTime;
      } else {
        name = url.searchParams.get('name') ?? '';
        payload =
          init?.body instanceof Uint8Array
            ? init.body
            : String(init?.body ?? '');
      }

      const hook = uploadHooks.get(name);
      if (hook !== undefined) {
        uploadHooks.delete(name);
        await hook();
      }
      if (precondition !== null && precondition !== '0') {
        const replaceHook = replaceHooks.get(name);
        if (replaceHook !== undefined) {
          replaceHooks.delete(name);
          await replaceHook();
        }
      }
      competingIncrement(name);

      if (precondition !== null) {
        const existing = objects.get(name);
        const current = existing === undefined ? 0 : existing.generation;
        if (String(current) !== precondition) {
          if (precondition === '0') {
            const conflictHook = createConflictHooks.get(name);
            if (conflictHook !== undefined) {
              createConflictHooks.delete(name);
              await conflictHook();
            }
          }
          return new Response('precondition failed', { status: 412 });
        }
      }

      if (payload instanceof Uint8Array) {
        media.set(name, payload);
        objects.set(name, { body: '', generation: nextGeneration++ });
      } else {
        objects.set(name, {
          body: payload,
          generation: nextGeneration++,
          ...(customTime === undefined ? {} : { customTime }),
        });
      }
      return new Response('{}', { status: 200 });
    }

    if (method === 'PUT' && !url.pathname.startsWith('/storage/')) {
      const name = decodeURIComponent(
        url.pathname.split('/').slice(2).join('/')
      );
      const match = new Headers(init?.headers).get(
        'x-goog-if-generation-match'
      );
      if (match === '0' && objects.has(name))
        return new Response('precondition failed', { status: 412 });
      const payload =
        init?.body instanceof Uint8Array
          ? init.body
          : new TextEncoder().encode(String(init?.body ?? ''));
      media.set(name, payload);
      objects.set(name, { body: '', generation: nextGeneration++ });
      return new Response('', { status: 200 });
    }

    // List: /storage/v1/b/{bucket}/o?prefix=
    const listMatch = /^\/storage\/v1\/b\/[^/]+\/o$/.exec(url.pathname);
    if (listMatch !== null && method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const items = [...objects.keys()]
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ name }));
      return Response.json({ items });
    }

    // Single object: /storage/v1/b/{bucket}/o/{name}
    const objectMatch = /^\/storage\/v1\/b\/[^/]+\/o\/(.+)$/.exec(url.pathname);
    if (objectMatch?.[1] !== undefined) {
      const name = decodeURIComponent(objectMatch[1]);
      if (method === 'PATCH') {
        const existing = objects.get(name);
        if (existing === undefined)
          return new Response('not found', { status: 404 });
        const expectedMeta = url.searchParams.get('ifMetagenerationMatch');
        if (
          expectedMeta !== null &&
          expectedMeta !== String(existing.metageneration ?? 1)
        )
          return new Response('precondition failed', { status: 412 });
        const metadata = JSON.parse(String(init?.body ?? '{}')) as {
          customTime?: string;
        };
        if (
          metadata.customTime === undefined ||
          (existing.customTime !== undefined &&
            metadata.customTime < existing.customTime)
        ) {
          return new Response('invalid customTime', { status: 400 });
        }
        const metageneration = (existing.metageneration ?? 1) + 1;
        objects.set(name, {
          ...existing,
          customTime: metadata.customTime,
          metageneration,
        });
        return Response.json({
          name,
          customTime: metadata.customTime,
          metageneration: String(metageneration),
        });
      }
      if (method === 'GET' && url.searchParams.get('alt') !== 'media') {
        const existing = objects.get(name);
        if (existing === undefined)
          return new Response('not found', { status: 404 });
        return Response.json({
          name,
          customTime: existing.customTime,
          metageneration: String(existing.metageneration ?? 1),
        });
      }

      if (method === 'DELETE') {
        const deleteHook = deleteHooks.get(name);
        if (deleteHook !== undefined) {
          deleteHooks.delete(name);
          await deleteHook();
        }
        const precondition = url.searchParams.get('ifGenerationMatch');
        if (precondition !== null) {
          const existing = objects.get(name);
          const current = existing === undefined ? 0 : existing.generation;
          if (String(current) !== precondition) {
            return new Response('precondition failed', { status: 412 });
          }
        }
        objects.delete(name);
        media.delete(name);
        return new Response('', { status: 204 });
      }

      if (media.has(name)) {
        return new Response(media.get(name) as BodyInit, {
          status: 200,
          headers: { 'x-goog-generation': '1' },
        });
      }

      const found = objects.get(name);
      if (found === undefined) {
        return new Response('not found', { status: 404 });
      }
      return new Response(found.body, {
        status: 200,
        headers: { 'x-goog-generation': String(found.generation) },
      });
    }

    return new Response('unhandled', { status: 500 });
  };

  return {
    fetch: handler as unknown as typeof globalThis.fetch,
    objects,
    requests,
    beforeNextUpload(name: string, hook: () => Promise<void>) {
      uploadHooks.set(name, hook);
    },
    afterNextCreateConflict(name: string, hook: () => Promise<void>) {
      createConflictHooks.set(name, hook);
    },
    beforeNextReplace(name: string, hook: () => Promise<void>) {
      replaceHooks.set(name, hook);
    },
    beforeNextDelete(name: string, hook: () => Promise<void>) {
      deleteHooks.set(name, hook);
    },
    contendOn(name: string, times: number) {
      bumps.set(name, times);
    },
  };
}

export function storeOn(gcs: FakeGcs, casAttempts?: number): RelicStore {
  return gcsStore({
    bucket: 'relics',
    getAccessToken: async () => 'token',
    host: 'https://gcs.test',
    fetch: gcs.fetch,
    ...(casAttempts === undefined ? {} : { casAttempts }),
  });
}
