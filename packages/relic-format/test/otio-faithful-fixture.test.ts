import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  isOtioRawNumber,
  parseOtioJson,
  stringifyOtioJson,
} from '../src/otio-json.ts';

const fixtureUrl = new URL(
  './fixtures/otio/edge-cases/faithful-tokens.otio.json',
  import.meta.url
);

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array`);
  }
  return value;
}

function expectRawToken(value: unknown, token: string): void {
  if (!isOtioRawNumber(value)) {
    throw new TypeError(`expected raw numeric token ${token}`);
  }
  expect(value.raw).toBe(token);
}

function assertFaithfulFixture(value: unknown): void {
  const timeline = record(value, 'timeline');
  const metadata = record(timeline['metadata'], 'timeline.metadata');
  const relic = record(metadata['relic'], 'timeline.metadata.relic');
  expectRawToken(relic['max_int64'], '9223372036854775807');
  expectRawToken(relic['min_int64'], '-9223372036854775808');
  expectRawToken(relic['non_finite_infinity'], 'Infinity');
  expectRawToken(relic['non_finite_nan'], 'NaN');

  const unknownMetadata = record(
    relic['unknown_schema_entity'],
    'timeline.metadata.relic.unknown_schema_entity'
  );
  expect(unknownMetadata['OTIO_SCHEMA']).toBe('UnknownVendorEntity.99');
  expect(unknownMetadata['vendor']).toBe('AcmePost');
  expect(unknownMetadata['token']).toBe('preserved-exact-value');

  const tracks = record(timeline['tracks'], 'timeline.tracks');
  const markers = array(tracks['markers'], 'timeline.tracks.markers');
  const marker = record(markers[0], 'timeline.tracks.markers[0]');
  expect(marker['OTIO_SCHEMA']).toBe('Marker.1');
  expect(marker['name']).toBe('Legacy Marker');

  const markerTime = record(marker['time'], 'timeline.tracks.markers[0].time');
  expect(markerTime['OTIO_SCHEMA']).toBe('RationalTime.1');
  expect(markerTime['rate']).toBe(24);
  expect(markerTime['value']).toBe(12);

  const children = array(tracks['children'], 'timeline.tracks.children');
  const unknownChild = record(children[0], 'timeline.tracks.children[0]');
  expect(unknownChild['OTIO_SCHEMA']).toBe('UnknownVendorEntity.99');
  expect(unknownChild['name']).toBe('Injected Unknown');
  expect(unknownChild['vendor']).toBe('AcmePost');
  expect(unknownChild['token']).toBe('preserved-exact-value');
}

describe('faithful OTIO fixture', () => {
  test('parses committed raw tokens and legacy schema objects', () => {
    const source = readFileSync(fixtureUrl, 'utf8');

    expect(source).toContain('"max_int64": 9223372036854775807');
    expect(source).toContain('"min_int64": -9223372036854775808');
    expect(source).toContain('"non_finite_infinity": Infinity');
    expect(source).toContain('"non_finite_nan": NaN');
    assertFaithfulFixture(parseOtioJson(source));
  });

  test('retains raw tokens and legacy schema objects through stable canonical serialization', () => {
    const first = stringifyOtioJson(
      parseOtioJson(readFileSync(fixtureUrl, 'utf8'))
    );

    expect(first).toContain('"max_int64":9223372036854775807');
    expect(first).toContain('"min_int64":-9223372036854775808');
    expect(first).toContain('"non_finite_infinity":Infinity');
    expect(first).toContain('"non_finite_nan":NaN');
    assertFaithfulFixture(parseOtioJson(first));
    expect(stringifyOtioJson(parseOtioJson(first))).toBe(first);
  });

  test('rejects an otherwise valid legacy marker list with a trailing comma', () => {
    const trailingComma = `{
      "OTIO_SCHEMA": "Timeline.1",
      "tracks": {
        "OTIO_SCHEMA": "Stack.1",
        "markers": [
          {
            "OTIO_SCHEMA": "Marker.1",
            "name": "Legacy Marker",
            "time": {
              "OTIO_SCHEMA": "RationalTime.1",
              "rate": 24.0,
              "value": 12.0
            },
            "color": "RED",
            "metadata": {}
          },
        ],
        "children": []
      }
    }`;

    expect(() => parseOtioJson(trailingComma)).toThrow(SyntaxError);
  });
});
