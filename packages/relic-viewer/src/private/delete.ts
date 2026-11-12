/**
 * Hard delete (section 4.7 and 4.13, mock `#delete-dialog`). The owner
 * chooses versions or the whole relic. The delete is attested with the
 * passkey over the exact scope, so the service removes only what was chosen.
 * The current version can only go with the whole relic.
 */

import type { PrivateAccessJSON } from '@relic/format/private';
import type { ViewerDeps } from '../viewer.ts';
import { privateKeysOf } from './ops.ts';
import {
  h,
  privateApi,
  problemMessage,
  setChildren,
  waiting,
} from './fingerprint-input.ts';
import { describeVersions } from './access-log.ts';

export interface DeleteContext {
  readonly relicId: string;
  readonly deps: ViewerDeps;
  /** Called with the outcome line after a delete settles. */
  onSettled(message: string, whole: boolean): void;
}

export interface DeleteDialog {
  readonly element: HTMLDialogElement;
  open(access: PrivateAccessJSON): void;
}

export function createDeleteDialog(ctx: DeleteContext): DeleteDialog {
  const picks = h('div', {
    class: 'version-picks delete-versions',
    id: 'delete-versions',
    role: 'group',
    'aria-label': 'Versions to delete',
  });
  const outcome = h('p', {
    class: 'dash-outcome',
    id: 'delete-outcome',
    role: 'status',
    'aria-live': 'polite',
  });
  const versionsRadio = h('input', {
    type: 'radio',
    name: 'delete-scope',
    value: 'versions',
    checked: true,
  });
  const allRadio = h('input', {
    type: 'radio',
    name: 'delete-scope',
    value: 'all',
  });
  const confirm = h(
    'button',
    {
      type: 'button',
      class: 'action danger',
      'data-action': 'confirm-delete',
      disabled: true,
    },
    'Delete with passkey'
  );
  const cancel = h(
    'button',
    { type: 'button', class: 'btn', id: 'delete-cancel' },
    'Cancel'
  );
  const dialog = h(
    'dialog',
    {
      class: 'sheet',
      id: 'delete-dialog',
      'aria-labelledby': 'delete-dialog-title',
    },
    h(
      'div',
      { class: 'sheet-body' },
      h('h2', { id: 'delete-dialog-title', tabindex: '-1' }, 'Delete'),
      h(
        'fieldset',
        { class: 'delete-choice' },
        h('legend', {}, 'What to delete'),
        h(
          'label',
          { class: 'radio' },
          versionsRadio,
          h('span', {}, 'Chosen versions')
        ),
        picks,
        h(
          'label',
          { class: 'radio' },
          allRadio,
          h('span', {}, 'The whole relic, every version')
        )
      ),
      h(
        'p',
        { class: 'sheet-warning', id: 'delete-warning' },
        'Deleting removes the encrypted content and every key, seal and comment for what you choose. Deleting the whole relic also removes its grants and requests. It can\u2019t be undone.'
      ),
      h(
        'p',
        { class: 'sheet-fine' },
        'The access log keeps a record of the deletion for as long as your retention setting says. One passkey tap.'
      ),
      outcome,
      h('div', { class: 'sheet-actions' }, confirm, cancel)
    )
  );

  let access: PrivateAccessJSON | undefined;

  function selectedVersions(): number[] {
    return [
      ...picks.querySelectorAll<HTMLInputElement>('input[data-delete-version]'),
    ]
      .filter((input) => input.checked && !input.disabled)
      .map((input) => Number(input.dataset.deleteVersion));
  }

  function sync(): void {
    confirm.disabled = !(allRadio.checked || selectedVersions().length > 0);
  }

  function render(): void {
    if (!access) return;
    const whole = allRadio.checked;
    const deleted = new Set(access.me.deleted_versions);
    picks.replaceChildren();
    for (let version = 1; version <= access.current_version; version++) {
      if (deleted.has(version)) continue;
      const current = version === access.current_version;
      const input = h('input', {
        type: 'checkbox',
        'data-delete-version': String(version),
        checked: whole,
        disabled: whole || current,
        'aria-describedby': current ? 'delete-current-note' : undefined,
        onchange: sync,
      });
      picks.append(
        h(
          'label',
          { class: 'pick' },
          input,
          `v${version}`,
          current
            ? h(
                'span',
                { class: 'lock-note', id: 'delete-current-note' },
                'current, goes only with the whole relic'
              )
            : null
        )
      );
    }
    sync();
  }

  versionsRadio.addEventListener('change', render);
  allRadio.addEventListener('change', render);
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', (event) => {
    if (confirm.hasAttribute('data-waiting')) event.preventDefault();
  });

  confirm.addEventListener('click', () => {
    const whole = allRadio.checked;
    const chosen = selectedVersions();
    if (!access || (!whole && chosen.length === 0)) return;
    void run(whole, chosen);
  });

  async function run(whole: boolean, chosen: readonly number[]): Promise<void> {
    const restore = waiting(confirm);
    const at = Date.now();
    try {
      const tapped = await privateKeysOf(ctx.deps).attest(ctx.deps, {
        purpose: 'delete',
        relicId: ctx.relicId,
        build: (identityId) => [
          {
            kind: 'delete',
            statement: {
              at,
              owner_identity_id: identityId,
              relic_id: ctx.relicId,
              versions: whole ? 'all' : [...chosen].sort((a, b) => a - b),
            },
          },
        ],
      });
      const answer = await privateApi<{
        deleted_versions: number[];
        relic_deleted: boolean;
      }>(ctx.deps, 'POST', `/api/relics/${ctx.relicId}/delete`, {
        attestation: tapped.bundle,
      });
      restore();
      dialog.close();
      const message = answer.relic_deleted
        ? 'Deleted. The relic, its keys, seals, grants, requests and comments are gone. Its link now says it was removed.'
        : `Deleted ${describeVersions(answer.deleted_versions)}. Readers can no longer fetch it.`;
      ctx.onSettled(message, answer.relic_deleted);
    } catch (error) {
      restore();
      setChildren(outcome, problemMessage(error));
      outcome.className = 'dash-outcome is-bad';
    }
  }

  return {
    element: dialog,
    open(next) {
      access = next;
      versionsRadio.checked = true;
      allRadio.checked = false;
      setChildren(outcome, '');
      outcome.className = 'dash-outcome';
      render();
      dialog.showModal();
    },
  };
}
