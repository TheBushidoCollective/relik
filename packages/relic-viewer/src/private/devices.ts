/**
 * Devices (section 4.7 and 4.12, mock `#devices` and `#device-approval`). An
 * agent such as relic-mcp publishes private relics with a certified device
 * key. Approval is two typed comparisons: the owner types the device
 * fingerprint relic-mcp shows before tapping, then types the owner fingerprint
 * this page shows into `relic_confirm_device`. Both are the full 160-bit form.
 */

import {
  type DevicePublicJSON,
  decodeBase64url,
  deviceFingerprint,
  deviceIdOf,
  formatFingerprint,
  type IdentityStateJSON,
  identityFingerprint,
} from '@relic/format/private';
import type { ViewerDeps } from '../viewer.ts';
import { formatUtcDay, formatUtcMinute } from './access-log.ts';
import {
  h,
  privateApi,
  problemMessage,
  setChildren,
  typedFingerprint,
  waiting,
  fingerprintGroups,
} from './fingerprint-input.ts';
import { attest } from './keys.ts';

/** A device certificate lasts a year (config `deviceCertMaxDays`). */
const DEVICE_CERT_MS = 365 * 24 * 60 * 60 * 1000;

export interface DevicesContext {
  readonly deps: ViewerDeps;
  readonly state: IdentityStateJSON;
  /** Called after a device is revoked or approved. */
  onChanged(message: string): void;
}

/** The device list with revoke, for the dashboard. */
export function devicesSection(ctx: DevicesContext): HTMLElement {
  const list = h('ul', { class: 'row-list', id: 'devices' });
  const outcome = h('p', {
    class: 'dash-outcome',
    id: 'device-outcome',
    role: 'status',
    'aria-live': 'polite',
  });
  void loadDevices(ctx, list, outcome);
  return h(
    'section',
    { class: 'dashboard-section', 'aria-labelledby': 'devices-title' },
    h(
      'h2',
      { class: 'dashboard-section-title', id: 'devices-title' },
      'Devices'
    ),
    h(
      'p',
      { class: 'dashboard-section-note' },
      'Agents such as relic-mcp that publish private relics for you without a passkey tap. Each one can read every private relic you own. Revoking one deletes its keys.'
    ),
    list,
    outcome
  );
}

async function loadDevices(
  ctx: DevicesContext,
  list: HTMLElement,
  outcome: HTMLElement
): Promise<void> {
  try {
    const answer = await privateApi<{ devices: DevicePublicJSON[] }>(
      ctx.deps,
      'GET',
      '/api/devices'
    );
    const rows = await Promise.all(
      answer.devices.map((device) => deviceRow(ctx, device, outcome))
    );
    setChildren(list, ...rows);
  } catch (error) {
    setChildren(outcome, problemMessage(error));
    outcome.className = 'dash-outcome is-bad';
  }
}

async function deviceRow(
  ctx: DevicesContext,
  device: DevicePublicJSON,
  outcome: HTMLElement
): Promise<HTMLElement> {
  const fingerprint = formatFingerprint(
    await deviceFingerprint(device.device_id)
  );
  const revoked = device.revoked_at !== null;
  const button = h(
    'button',
    {
      type: 'button',
      class: 'btn is-small is-danger',
      'data-action': 'revoke-device',
      'aria-label': `Revoke ${device.label}`,
    },
    'Revoke'
  );
  button.addEventListener('click', () => {
    void revokeDevice(ctx, device, button, outcome);
  });
  return h(
    'li',
    { 'data-device': device.device_id },
    h(
      'span',
      { class: 'row-main' },
      h('strong', {}, device.label),
      h(
        'span',
        { class: 'row-meta' },
        revoked
          ? `Revoked ${formatUtcDay(device.revoked_at ?? 0)}.`
          : `${device.backend}. Certified ${formatUtcDay(device.certified_at)}, until ${formatUtcDay(device.not_after)}.`
      ),
      h('span', { class: 'row-meta is-mono' }, fingerprint)
    ),
    revoked ? h('span', { class: 'row-kind' }, 'Revoked') : button
  );
}

async function revokeDevice(
  ctx: DevicesContext,
  device: DevicePublicJSON,
  button: HTMLButtonElement,
  outcome: HTMLElement
): Promise<void> {
  const restore = waiting(button, 'Waiting');
  const at = Date.now();
  try {
    const tapped = await attest(ctx.deps, {
      purpose: 'device_revoke',
      build: (identityId) => [
        {
          kind: 'device_revocation',
          statement: {
            at,
            device_id: device.device_id,
            owner_identity_id: identityId,
          },
        },
      ],
    });
    await privateApi(
      ctx.deps,
      'POST',
      `/api/devices/${device.device_id}/revoke`,
      { attestation: tapped.bundle }
    );
    restore();
    outcome.className = 'dash-outcome is-ok';
    const message = `Revoked ${device.label}. Its keys are deleted, and new versions aren\u2019t wrapped to it.`;
    setChildren(outcome, message);
    ctx.onChanged(message);
  } catch (error) {
    restore();
    outcome.className = 'dash-outcome is-bad';
    setChildren(outcome, problemMessage(error));
  }
}

/** The device-approval section for `/dashboard?approve-device=<enrollmentId>`. */
export function deviceApprovalSection(
  enrollmentId: string,
  ctx: DevicesContext
): HTMLElement {
  const body = h('div', {});
  void loadEnrollment(ctx, enrollmentId, body);
  return h(
    'section',
    {
      class: 'dashboard-section is-attention',
      id: 'device-approval',
      'data-device-approval': enrollmentId,
      'aria-labelledby': 'approval-title',
    },
    h(
      'h2',
      {
        class: 'dashboard-section-title',
        id: 'approval-title',
        tabindex: '-1',
      },
      'Approve a device'
    ),
    body
  );
}

interface EnrollmentJSON {
  readonly status: 'pending' | 'approved';
  readonly device_id: string;
  readonly label: string;
  readonly expires_at: string;
  /** The device's public keys, returned while the enrollment is pending. */
  readonly kem_public_key?: string;
  readonly sig_public_key?: string;
}

async function loadEnrollment(
  ctx: DevicesContext,
  enrollmentId: string,
  body: HTMLElement
): Promise<void> {
  let enrollment: EnrollmentJSON;
  try {
    enrollment = await privateApi<EnrollmentJSON>(
      ctx.deps,
      'GET',
      `/api/devices/enrollments/${enrollmentId}`
    );
  } catch (error) {
    setChildren(
      body,
      h('p', { class: 'dashboard-section-note' }, problemMessage(error))
    );
    return;
  }
  if (enrollment.status !== 'pending') {
    setChildren(
      body,
      h(
        'p',
        { class: 'dashboard-section-note' },
        'This device is already approved.'
      )
    );
    return;
  }
  const field = typedFingerprint({
    id: 'device-fp',
    label: 'Device fingerprint relic-mcp showed you',
    inputHook: 'data-device-fingerprint-input',
    placeholder: 'Type it from relic-mcp\u2019s output on your own machine',
    expected: await deviceFingerprint(enrollment.device_id),
    who: enrollment.label,
  });
  const approve = h(
    'button',
    {
      type: 'button',
      class: 'action primary',
      'data-action': 'approve-device',
      disabled: true,
    },
    'Approve with passkey'
  );
  const outcome = h('p', {
    class: 'dash-outcome',
    role: 'status',
    'aria-live': 'polite',
  });
  const step2 = h('li', {
    id: 'approval-step-2',
    'aria-disabled': 'true',
    hidden: true,
  });
  field.onChange((state) => {
    approve.disabled = state !== 'match';
  });
  approve.addEventListener('click', () => {
    const typed = field.matched();
    if (!typed) return;
    void approveDevice(
      ctx,
      enrollmentId,
      enrollment,
      typed,
      approve,
      outcome,
      step2
    );
  });
  setChildren(
    body,
    h(
      'dl',
      { class: 'facts' },
      h('dt', {}, 'DEVICE'),
      h('dd', {}, enrollment.label),
      h('dt', {}, 'REQUEST EXPIRES'),
      h(
        'dd',
        { class: 'is-mono' },
        `${formatUtcMinute(enrollment.expires_at)} UTC`
      )
    ),
    h(
      'ol',
      { class: 'approval-steps' },
      h(
        'li',
        { id: 'approval-step-1' },
        field.element,
        h('div', { class: 'card-actions' }, approve),
        outcome
      ),
      step2
    )
  );
}

async function approveDevice(
  ctx: DevicesContext,
  enrollmentId: string,
  enrollment: EnrollmentJSON,
  typed: string,
  button: HTMLButtonElement,
  outcome: HTMLElement,
  step2: HTMLElement
): Promise<void> {
  const kemHex = enrollment.kem_public_key;
  const sigHex = enrollment.sig_public_key;
  if (!kemHex || !sigHex) {
    setChildren(
      outcome,
      'This enrollment did not carry the device keys. Start the enrollment again from relic-mcp. Nothing was approved.'
    );
    return;
  }
  const kemPublicKey = decodeBase64url(kemHex);
  const sigPublicKey = decodeBase64url(sigHex);
  if ((await deviceIdOf(kemPublicKey, sigPublicKey)) !== enrollment.device_id) {
    setChildren(
      outcome,
      'The device keys do not match the device ID. Nothing was approved.'
    );
    return;
  }
  const restore = waiting(button);
  const at = Date.now();
  try {
    const tapped = await attest(ctx.deps, {
      purpose: 'device_approve',
      build: (identityId) => [
        {
          kind: 'device_cert',
          statement: {
            at,
            device_fingerprint_typed: typed,
            device_id: enrollment.device_id,
            kem_public_key: kemHex,
            label: enrollment.label,
            not_after: at + DEVICE_CERT_MS,
            owner_identity_id: identityId,
            sig_public_key: sigHex,
          },
        },
      ],
    });
    await privateApi(
      ctx.deps,
      'POST',
      `/api/devices/enrollments/${enrollmentId}/approve`,
      {
        attestation: tapped.bundle,
      }
    );
    restore();
    const owner = formatFingerprint(
      await identityFingerprint(
        tapped.identity.identityId,
        tapped.identity.email
      )
    );
    setChildren(
      step2,
      h(
        'p',
        { class: 'fp-caption', id: 'fp-device-owner-caption' },
        'Now give relic-mcp your fingerprint'
      ),
      h(
        'p',
        {
          class: 'fingerprint',
          'data-fingerprint': 'owner-for-device',
          'aria-labelledby': 'fp-device-owner-caption',
        },
        ...fingerprintGroups(owner)
      ),
      h(
        'p',
        { class: 'dashboard-section-note', id: 'approval-step-2-note' },
        'Type it into relic_confirm_device. relic-mcp compares it with the owner Relic reports and won\u2019t publish until they match.'
      )
    );
    step2.hidden = false;
    step2.setAttribute('aria-disabled', 'false');
    button.hidden = true;
    ctx.onChanged('');
  } catch (error) {
    restore();
    setChildren(outcome, problemMessage(error));
  }
}
