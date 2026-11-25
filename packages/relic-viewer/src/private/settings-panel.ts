import type { RelicSettingsJSON } from '@relic/format/private';
import type { ViewerDeps } from '../viewer.ts';
import { h, privateApi, problemMessage, waiting } from './fingerprint-input.ts';
import { nowMs } from './keys.ts';
import { privateKeysOf } from './ops.ts';

export function openSettingsPanel(options: {
  relicId: string;
  private: boolean;
  settings: RelicSettingsJSON;
  deps: ViewerDeps;
  onSaved(settings: RelicSettingsJSON): void;
}): HTMLElement {
  const { relicId, deps } = options;
  const checks = {
    suggestions: h('input', { type: 'checkbox', role: 'switch' }),
    comments: h('input', { type: 'checkbox', role: 'switch' }),
    decisions: h('input', { type: 'checkbox', role: 'switch' }),
    signing: h('input', { type: 'checkbox', role: 'switch' }),
    notifications: h('input', { type: 'checkbox', role: 'switch' }),
  };
  for (const key of Object.keys(checks) as (keyof typeof checks)[]) {
    checks[key].checked = options.settings[key];
  }
  const mode = h(
    'select',
    { 'aria-label': 'Lifetime' },
    h('option', { value: 'keep' }, 'Keep current lifetime'),
    ...(!options.private
      ? [h('option', { value: 'never' }, 'Never expires')]
      : []),
    h('option', { value: 'days' }, 'Days from today')
  );
  const days = h('input', {
    type: 'number',
    min: '1',
    max: options.private ? '365' : '3650',
    step: '1',
    'aria-label': 'Lifetime in days',
  });
  days.hidden = true;
  mode.addEventListener('change', () => {
    days.hidden = mode.value !== 'days';
  });
  const notice = h('p', {
    class: 'panel-notice',
    role: 'status',
    'aria-live': 'polite',
  });
  const save = h(
    'button',
    { type: 'submit', class: 'btn' },
    'Save with passkey'
  );
  const panel = h(
    'aside',
    {
      class: 'access-panel',
      role: 'dialog',
      'aria-labelledby': 'settings-title',
      id: 'settings-panel',
    },
    h(
      'div',
      { class: 'panel-head' },
      h(
        'h2',
        { class: 'panel-title', id: 'settings-title', tabindex: '-1' },
        'Settings'
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'panel-close',
          'aria-label': 'Close settings',
          onclick: () => panel.remove(),
        },
        '×'
      )
    ),
    h(
      'form',
      { class: 'panel-body' },
      h(
        'p',
        { class: 'panel-lead' },
        'Changes apply without publishing a new version.'
      ),
      ...(
        [
          ['suggestions', 'Suggested edits'],
          ['comments', 'Comments'],
          ['decisions', 'Decisions'],
          ['signing', 'Signing'],
          ['notifications', 'Notification emails'],
        ] as const
      ).map(([key, label]) =>
        h(
          'section',
          { class: 'panel-section' },
          h('label', {}, checks[key], ` ${label}`),
          key === 'suggestions'
            ? h(
                'p',
                { class: 'panel-lead' },
                'Turning this off applies when someone opens the relik; a page already open can still send one until it reloads.'
              )
            : null,
          key === 'comments'
            ? h(
                'p',
                { class: 'panel-lead' },
                'Turning comments off also stops suggestions.'
              )
            : null
        )
      ),
      h(
        'section',
        { class: 'panel-section' },
        h('h3', {}, 'Lifetime'),
        h(
          'p',
          { class: 'panel-lead' },
          options.settings.expires_at === null
            ? 'Currently never expires.'
            : `Currently expires ${options.settings.expires_at}.`
        ),
        mode,
        days,
        h(
          'p',
          { class: 'panel-lead' },
          options.private
            ? 'Choose at most 365 days from today. Shortening ends access at the new time but does not remove the stored copy sooner.'
            : 'Choose at most 3650 days from today.'
        )
      ),
      save,
      notice
    )
  );
  panel.querySelector('form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = Number(days.value);
    const max = options.private ? 365 : 3650;
    if (
      mode.value === 'days' &&
      (!Number.isInteger(value) || value < 1 || value > max)
    ) {
      notice.textContent = `Choose a whole number of days from 1 to ${max}.`;
      return;
    }
    const lifetime =
      mode.value === 'days' ? value : mode.value === 'never' ? 'never' : 'keep';
    const restore = waiting(save);
    void (async () => {
      try {
        const tapped = await privateKeysOf(deps).attest(deps, {
          purpose: 'relic_settings',
          relicId,
          build: (identityId) => [
            {
              kind: 'relic_settings',
              statement: {
                at: nowMs(deps),
                relic_id: relicId,
                owner_identity_id: identityId,
                suggestions: checks.suggestions.checked,
                comments: checks.comments.checked,
                decisions: checks.decisions.checked,
                signing: checks.signing.checked,
                notifications: checks.notifications.checked,
                lifetime,
              },
            },
          ],
        });
        const result = await privateApi<{ settings: RelicSettingsJSON }>(
          deps,
          'POST',
          `/api/relics/${encodeURIComponent(relicId)}/settings`,
          { attestation: tapped.bundle }
        );
        options.onSaved(result.settings);
        document.body.append(panel);
        notice.textContent = 'Saved. Changed just now.';
        mode.value = 'keep';
        days.hidden = true;
      } catch (error) {
        notice.textContent = problemMessage(error);
      } finally {
        restore();
      }
    })();
  });
  document.body.append(panel);
  panel.querySelector<HTMLElement>('#settings-title')?.focus();
  return panel;
}
