import assert from 'node:assert/strict';

export interface TapQuantum {
  label: number;
  length: number;
  ordinal: number;
  offset: number;
  carrier: readonly (number | null)[];
}

export interface GateQuantum {
  clockEpoch: number;
  cachedCurrentFrame: number;
  callbackOrdinal: number;
  sampleCount: number;
  certifiedFrame: number;
  startFrame: number;
  endFrame: number;
  serial: number;
  frames: readonly number[];
  tags: readonly number[];
}

/** Associate using the entire raw label/length sequence, never carrier values. */
export function associateGateSequence(
  tap: readonly TapQuantum[],
  gate: readonly GateQuantum[],
  epoch: number
): { start: number; offset: number } {
  assert.ok(gate.length >= 2, 'at least two gate quanta required');
  for (let i = 0; i < tap.length; i++) {
    const q = tap[i]!;
    assert.ok(
      Number.isSafeInteger(q.ordinal) &&
        Number.isSafeInteger(q.offset) &&
        Number.isSafeInteger(q.label) &&
        Number.isSafeInteger(q.length) &&
        q.length > 0 &&
        q.carrier.length === q.length,
      'invalid tap quantum'
    );
    if (i) {
      const p = tap[i - 1]!;
      assert.equal(q.ordinal, p.ordinal + 1, 'tap ordinal gap or reorder');
      assert.equal(
        q.offset,
        p.offset + p.length,
        'tap sample offset gap or reorder'
      );
    }
  }
  for (let i = 0; i < gate.length; i++) {
    const q = gate[i]!;
    assert.equal(q.clockEpoch, epoch, 'wrong gate clock epoch');
    assert.ok(
      Number.isSafeInteger(q.callbackOrdinal) &&
        Number.isSafeInteger(q.sampleCount) &&
        Number.isSafeInteger(q.certifiedFrame) &&
        q.frames.length > 0,
      'invalid gate quantum'
    );
    if (i) {
      const p = gate[i - 1]!;
      assert.equal(
        q.callbackOrdinal,
        p.callbackOrdinal + 1,
        'gate ordinal gap or reorder'
      );
      assert.equal(
        q.sampleCount,
        p.sampleCount + p.frames.length,
        'gate sample offset gap or reorder'
      );
    }
  }
  const candidates: number[] = [];
  for (let start = 0; start + gate.length <= tap.length; start++) {
    if (
      gate.every(
        (g, i) =>
          tap[start + i]!.label === g.cachedCurrentFrame &&
          tap[start + i]!.length === g.frames.length
      )
    )
      candidates.push(start);
  }
  assert.equal(
    candidates.length,
    1,
    'gate and tap callback sequence cannot be uniquely aligned'
  );
  const start = candidates[0]!;
  const offset = tap[start]!.offset - gate[0]!.sampleCount;
  for (let i = 0; i < gate.length; i++)
    assert.equal(
      tap[start + i]!.offset - gate[i]!.sampleCount,
      offset,
      'gate/tap offset changed'
    );
  return { start, offset };
}

/** Check independently associated actual native samples against carrier, without fitting offsets. */
export function assertAssociatedSamples(
  tap: readonly TapQuantum[],
  gate: readonly GateQuantum[],
  start: number,
  requiredStart: number,
  requiredEnd: number
): void {
  assert.ok(
    Number.isSafeInteger(requiredStart) &&
      Number.isSafeInteger(requiredEnd) &&
      requiredEnd > requiredStart,
    'invalid required carrier interval'
  );
  let covered = 0;
  for (let i = 0; i < gate.length; i++) {
    const g = gate[i]!;
    const q = tap[start + i];
    assert.ok(
      q &&
        q.length === g.frames.length &&
        (g.tags.length === 1 || g.tags.length === q.length),
      'missing aligned native samples'
    );
    assert.ok(
      Number.isSafeInteger(g.startFrame) &&
        Number.isSafeInteger(g.endFrame) &&
        Number.isSafeInteger(g.serial),
      'invalid native bank'
    );
    for (let j = 0; j < q.length; j++) {
      const native = g.frames[j]!;
      assert.ok(
        Number.isFinite(native) &&
          Math.abs(native - Math.round(native)) < 1 / 16,
        'invalid native frame'
      );
      assert.equal(
        g.tags[g.tags.length === 1 ? 0 : j],
        g.serial,
        'invalid native tag'
      );
      const certified = g.certifiedFrame + j;
      assert.equal(
        g.startFrame + Math.round(native),
        certified,
        'native frame disagrees with certification'
      );
      assert.ok(
        certified >= g.startFrame && certified < g.endFrame,
        'certified frame outside bank'
      );
      if (certified >= requiredStart && certified < requiredEnd) {
        assert.equal(
          q.carrier[j],
          certified,
          'independent carrier disagrees with certified frame'
        );
        covered++;
      }
    }
  }
  assert.equal(
    covered,
    requiredEnd - requiredStart,
    'required carrier interval missing or duplicated'
  );
}
