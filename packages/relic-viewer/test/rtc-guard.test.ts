import { describe, expect, test } from 'bun:test';
import { removeRtcConstructors } from '../src/rtc-guard.ts';

describe('removeRtcConstructors', () => {
  test('makes each WebRTC constructor undefined, and keeps it that way', () => {
    const target: Record<string, unknown> = {
      RTCPeerConnection: function PeerConnection() {},
      webkitRTCPeerConnection: function Legacy() {},
      RTCDataChannel: function Channel() {},
      RTCRtpTransceiver: function Transceiver() {},
    };
    removeRtcConstructors(target);
    for (const name of [
      'RTCPeerConnection',
      'webkitRTCPeerConnection',
      'RTCDataChannel',
      'RTCRtpTransceiver',
    ]) {
      expect(target[name]).toBeUndefined();
    }
    // A later write cannot restore a constructor: the property is
    // non-writable and non-configurable.
    expect(() => {
      target['RTCPeerConnection'] = function Again() {};
    }).toThrow();
    expect(target['RTCPeerConnection']).toBeUndefined();
  });

  test('removes an RTC-prefixed name the list does not name', () => {
    const target: Record<string, unknown> = {
      RTCSomethingNew: function Later() {},
    };
    removeRtcConstructors(target);
    expect(target['RTCSomethingNew']).toBeUndefined();
  });

  test('leaves unrelated globals alone', () => {
    const fetchFn = () => 'fetch';
    const target: Record<string, unknown> = {
      fetch: fetchFn,
      RTCPeerConnection: function PeerConnection() {},
    };
    removeRtcConstructors(target);
    expect(target['fetch']).toBe(fetchFn);
  });
});
