/**
 * Signing loopback acceptance path.
 * RELIC_CHROME_PATH=<owned headless shell> bun packages/relic-mcp/test/signing-path.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeKey, deriveShareProof, encodeKey } from '@relic/format';
import { deriveSigningKey, type SigningRequestJSON } from '@relic/format/signing';
import { contentFromBytes } from '../../relic-viewer/src/content.ts';
import { verifyViewerSigningRequest } from '../../relic-viewer/src/signing/api.ts';
import { identityFingerprint } from '@relic/format/private';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { callMcp } from './decision-proof-steps.ts';
import { clickPrivateControl } from './confirmation-private-proof.ts';
import {
  approveDeviceFromProcess, bootstrapOwner, goto, inPage, launchActor,
  nodeSignIn, pageCreatePasskey, poll, sessionCookieParams, click, waitForState, waitForOpened,
  stepsFourAndFive, stepSeven, openPanel, callMcpRaw, type Actor, type CapturedMail, type PrivateShareEnv,
} from './private-shares-steps.ts';

const chromePath = process.env['RELIC_CHROME_PATH'];
if (!chromePath || chromePath === 'none') throw new Error('RELIC_CHROME_PATH must name an owned headless shell');
const scratch = await mkdtemp(join(tmpdir(), 'relik-signing-path-'));
const statePath = join(scratch, 'state.json');
const bundle = fileURLToPath(new URL('../dist/relic-mcp.js', import.meta.url));
const viewer = fileURLToPath(new URL('../../relic-viewer/dist/', import.meta.url));
const store = new MemoryStore();
const mails: CapturedMail[] = [];
const actors: Actor[] = [];
let handler: ((request: Request) => Promise<Response>) | undefined;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => handler ? handler(request) : new Response('not ready', { status: 503 }) });
const origin = `http://localhost:${server.port}`;
const storage = new MemoryStorage(`${origin}/__storage`);
const options = {
  config: { serviceOrigin: origin }, store, storage, assets: diskAssets(viewer),
  now: () => Date.now(),
  mailer: {
    send: async (to: string, link: string, code?: string) => { mails.push({ to, subject: 'sign-in', text: link, link, ...(code === undefined ? {} : { code }) }); },
    sendMail: async (to: string, mail: { subject: string; text: string }) => { mails.push({ to, ...mail }); },
  },
};
const apps = [createApp(options), createApp(options)];
const pausedApp = createApp({ ...options, config: { serviceOrigin: origin, killSwitchEngaged: true } });
let pauseSignature = false;
let pausedSignature: Request | undefined;
let pausedSignatureStatus = 0;
let next = 0;
let denyOpenedFor = '';
let deleteStatus = 0;
handler = async request => {
  const url = new URL(request.url);
  if (denyOpenedFor && url.pathname === `/api/relics/${denyOpenedFor}/receipts/opened`) {
    return Response.json({code: 'service_paused'}, {status:503});
  }
  if (pauseSignature && url.pathname.endsWith('/signing/signatures')) {
    pauseSignature = false;
    pausedSignature = request.clone();
    const response = await pausedApp.fetch(request);
    pausedSignatureStatus = response.status;
    return response;
  }
  if (url.pathname.startsWith('/__storage/upload/') && request.method === 'PUT') {
    storage.put(url.pathname.slice('/__storage/upload/'.length), new Uint8Array(await request.arrayBuffer()));
    return new Response(null, { status: 200 });
  }
  if (url.pathname.startsWith('/__storage/o/') && request.method === 'GET') {
    const data = await storage.read(url.pathname.slice('/__storage/o/'.length));
    return data ? new Response(Buffer.from(data)) : new Response('not found', { status: 404 });
  }
  const response = await apps[(next++ % 2)]!.fetch(request);
  if (url.pathname.endsWith('/delete')) deleteStatus = response.status;
  return response;
};
const mcp = (name: string, args: Record<string, unknown>) => callMcp(['node', bundle], scratch, statePath, origin, name, args);
const env: PrivateShareEnv = {
  serviceOrigin: origin, scratchDir: scratch, statePath, mcpCommand: ['node', bundle], chromePath,
  owner: 'owner+signing@example.test', reader: 'ana+signing@example.test', third: 'ben+signing@example.test', noPrf: 'other+signing@example.test',
  store, storage, receipt: () => {}, defect: (id, evidence) => { throw new Error(`DEFECT ${id}: ${evidence}`); },
  mailbox: {
    mark: () => mails.length, all: () => mails,
    async await(to, since, match, label) { return poll(label, 20000, async () => mails.slice(since).find(mail => mail.to.toLowerCase() === to.toLowerCase() && match(mail))); },
  },
};
function text(value: unknown): string { assert.equal(typeof value, 'string'); return value as string; }
try {
  const owner = await launchActor(env, 'owner', env.owner, true); actors.push(owner);
  const cookie = await nodeSignIn(env, env.owner);
  await owner.browser.cdp.send('Network.setCookie', sessionCookieParams(env, cookie), owner.browser.sessionId);
  await goto(owner.browser, `${origin}/dashboard`);
  await inPage(owner.browser, pageCreatePasskey, { prf: true });
  const ownerKeys = await bootstrapOwner(env, owner, cookie);
  const enrollment = await mcp('relic_enroll_device', { label: 'signing proof' });
  await approveDeviceFromProcess(env, owner, ownerKeys, text(enrollment.enrollment_id), text(enrollment.device_fingerprint));
  await mcp('relic_confirm_device', { owner_fingerprint: await identityFingerprint(ownerKeys.identityId, env.owner) });
  const file = join(scratch, 'signing-proof.txt');
  await Bun.write(file, 'Signing acceptance path\n');
  const published = await mcp('relic_publish', { path: file, title: 'Signing acceptance', cover: false });
  const id = text(published.relic_id);
  const publicMailStart = mails.length;
  const request = await mcp('relic_request_signatures', { relic_id: id, signers: [{ email: env.reader }, { email: env.third }], order: 'sequential' });
  assert.equal(request.status, 'open');
  assert.equal(request.order, 'sequential');
  assert.ok(Array.isArray(request.invitations));
  assert.equal(request.invitations.length, 2);
  for (const invite of request.invitations) assert.ok(text(invite.text).includes('#'));
  console.log('PUBLIC_REQUEST_CREATED signers=2 order=sequential invitations_have_fragment=true');
  const ben = await launchActor(env, 'ben', env.third, true); actors.push(ben);
  const benCookie = await nodeSignIn(env, env.third);
  await ben.browser.cdp.send('Network.setCookie', sessionCookieParams(env, benCookie), ben.browser.sessionId);
  await goto(ben.browser, `${origin}/dashboard`);
  await inPage(ben.browser, pageCreatePasskey, { prf: true });
  await goto(ben.browser, text(published.url));
  const localState = JSON.parse(await readFile(statePath, 'utf8'));
  const proof = encodeKey(await deriveShareProof(decodeKey(localState.relics[id].key)));
  const requestRead = await fetch(`${origin}/api/relics/${id}/signing/read`, {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({share_proof:proof}),
  });
  assert.equal(requestRead.status, 200);
  const wire = await requestRead.json() as { requests: SigningRequestJSON[] };
  const signedRequest = wire.requests[0]!;
  await assert.rejects(verifyViewerSigningRequest({
    request:signedRequest, relicId:id, version:1,
    digest: text(signedRequest.request.statement.ciphertext_sha256),
    content:contentFromBytes(new TextEncoder().encode('A swapped document')),
    signingKey:await deriveSigningKey(decodeKey(localState.relics[id].key)),
    access:'public', origin, pdf:false,
  }), /signing_content_mismatch/);
  console.log('VIEWER_CONTENT_MAC swapped_content=refused');
  const refusal = await ben.browser.evaluate<{ status: number; code: string }>(`(async () => {
    const response = await fetch(${JSON.stringify(`/api/relics/${id}/signing/options`)}, {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({request_id: ${JSON.stringify(request.request_id)}, share_proof: ${JSON.stringify(proof)}})
    });
    return {status: response.status, code: (await response.json()).code};
  })()`);
  assert.deepEqual(refusal, { status: 409, code: 'signing_not_your_turn' });
  console.log('SIGNING_STEP_4_OUT_OF_TURN options=409');
  const reader = await launchActor(env, 'ana', env.reader, true); actors.push(reader);
  const readerCookie = await nodeSignIn(env, env.reader);
  await reader.browser.cdp.send('Network.setCookie', sessionCookieParams(env, readerCookie), reader.browser.sessionId);
  await goto(reader.browser, `${origin}/dashboard`);
  await inPage(reader.browser, pageCreatePasskey, { prf: true });
  await mcp('relic_settings', { relic_id: id, signing: false });
  await goto(reader.browser, text(published.url));
  await poll('paused signing notice', 15000, async () =>
    (await reader.browser.evaluate<boolean>(`document.body.innerText.includes('Signing is paused by the owner.') && !!Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Sign here' && b.disabled)`)) ? true : undefined
  );
  console.log('SIGNING_PAUSED notice=present sign=disabled');
  await mcp('relic_settings', { relic_id: id, signing: true });
  await goto(reader.browser, `${origin}/${id}?refresh=signing${new URL(text(published.url)).hash}`);
  await poll('sign here button', 15000, async () => (await reader.browser.evaluate<boolean>(`Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Sign here')`)) ? true : undefined).catch(async error => {
    throw new Error(`${error.message}: ${await reader.browser.evaluate<string>('document.body.innerText')}`);
  });
  await reader.browser.evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Sign here').click()`);
  await reader.browser.waitForSelector('.signing-panel input');
  await reader.browser.evaluate(`(() => {
    const panel = document.querySelector('.signing-panel');
    const name = panel.querySelector('input:not([type=checkbox])');
    name.value = 'Ana Signer';
    name.dispatchEvent(new Event('input', {bubbles:true}));
    panel.querySelector('input[type=checkbox]').click();
  })()`);
  await poll('signature prepared', 15000, async () => (await reader.browser.evaluate<boolean>(`!!document.querySelector('.signing-panel .sign-row button.primary:not(:disabled)')`)) ? true : undefined).catch(async error => {
    throw new Error(`${error.message}: ${await reader.browser.evaluate<string>('document.body.innerText')}`);
  });
  pauseSignature = true;
  await reader.browser.evaluate(`document.querySelector('.signing-panel .sign-row button.primary').click()`);
  await poll('paused signature response', 15000, async () => pausedSignatureStatus ? true : undefined);
  assert.equal(pausedSignatureStatus, 503);
  assert.ok(pausedSignature);
  const resumedSignature = await apps[0]!.fetch(pausedSignature);
  assert.equal(resumedSignature.status, 201, await resumedSignature.clone().text());
  console.log('SIGNING_KILL_SWITCH refused=503 challenge_preserved=true');
  await poll('first signature', 15000, async () => {
    const result = await mcp('relic_read_signing', { relic_id: id });
    const requests = result.requests as Array<{ signers: Array<{ status: string }> }>;
    return requests[0]?.signers[0]?.status === 'signed' ? true : undefined;
  });
  assert.ok(mails.slice(publicMailStart).some(mail => mail.to === env.third && mail.subject.includes('turn to sign')));
  console.log('PUBLIC_SIGNER_1 signed=true');
  await Bun.write(file, 'Changed signing acceptance content\n');
  const openRepublish = await callMcpRaw(env, 'relic_republish', {relic_id: id, path: file, cover: false});
  assert.equal(openRepublish.isError, true);
  assert.equal(openRepublish.structured.code, 'signing_in_progress');
  await Bun.write(file, 'Signing acceptance path\n');
  console.log('SIGNING_STEP_6_REPUBLISH_WHILE_OPEN 409 signing_in_progress');
  await goto(ben.browser, `${origin}/${id}?refresh=1${new URL(text(published.url)).hash}`);
  await poll('ben sign here button', 15000, async () => (await ben.browser.evaluate<boolean>(`Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Sign here')`)) ? true : undefined);
  await ben.browser.evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Sign here').click()`);
  await ben.browser.waitForSelector('.signing-panel input');
  await ben.browser.evaluate(`(() => {
    const panel = document.querySelector('.signing-panel');
    const name = panel.querySelector('input:not([type=checkbox])');
    name.value = 'Ben Signer';
    name.dispatchEvent(new Event('input', {bubbles:true}));
    Array.from(panel.querySelectorAll('button')).find(b => b.textContent === 'Draw').click();
  })()`);
  const rect = await ben.browser.evaluate<{x: number; y: number}>(`(() => { const r = document.querySelector('.mark-pad canvas').getBoundingClientRect(); return {x:r.left + r.width / 3, y:r.top + r.height / 2}; })()`);
  await ben.browser.cdp.send('Input.dispatchMouseEvent', {type:'mousePressed', x:rect.x, y:rect.y, button:'left', clickCount:1}, ben.browser.sessionId);
  await ben.browser.cdp.send('Input.dispatchMouseEvent', {type:'mouseMoved', x:rect.x + 40, y:rect.y + 10, button:'left'}, ben.browser.sessionId);
  await ben.browser.cdp.send('Input.dispatchMouseEvent', {type:'mouseReleased', x:rect.x + 40, y:rect.y + 10, button:'left', clickCount:1}, ben.browser.sessionId);
  await ben.browser.evaluate(`document.querySelector('.signing-panel input[type=checkbox]').click()`);
  await poll('ben signature prepared', 15000, async () => (await ben.browser.evaluate<boolean>(`!!document.querySelector('.signing-panel .sign-row button.primary:not(:disabled)')`)) ? true : undefined).catch(async error => { throw new Error(`${error.message}: ${await ben.browser.evaluate<string>('document.body.innerText')}`); });
  await ben.browser.evaluate(`document.querySelector('.signing-panel .sign-row button.primary').click()`);
  await poll('completed signing', 15000, async () => {
    const result = await mcp('relic_read_signing', { relic_id: id });
    const requests = result.requests as Array<{ status: string }>;
    return requests[0]?.status === 'complete' ? true : undefined;
  });
  const completionMails = mails.slice(publicMailStart).filter(mail => mail.subject.startsWith('Everyone signed'));
  assert.equal(completionMails.length, 3);
  assert.ok(completionMails.every(mail => Array.isArray(Reflect.get(mail, 'attachments')) && Reflect.get(mail, 'attachments').length === 1));
  assert.ok(mails.slice(publicMailStart).filter(mail => mail.subject.includes('sign')).every(mail => !mail.text.includes('#')));
  console.log('PUBLIC_SIGNER_2 complete=true drawn=true');
  await goto(ben.browser, `${origin}/${id}?refresh=2${new URL(text(published.url)).hash}`);
  await ben.browser.waitForSelector('[data-action="open-signing"]', 25000);
  await ben.browser.evaluate(`document.querySelector('[data-action="open-signing"]').click()`);
  await poll('certificate control', 15000, async () => (await ben.browser.evaluate<boolean>(`Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'View certificate')`)) ? true : undefined);
  await ben.browser.evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'View certificate').click()`);
  await ben.browser.waitForSelector('.certificate-view', 25000);
  const label = await ben.browser.evaluate<string>(`document.querySelector('.certificate-result').textContent`);
  assert.ok(label.includes('owner identity has not been independently checked'), label);
  await ben.browser.cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: scratch }, ben.browser.sessionId);
  await ben.browser.evaluate(`Array.from(document.querySelectorAll('.certificate-view button')).find(b => b.textContent === 'Download certificate').click()`);
  const certificatePath = join(scratch, `relik-${id}-v1-signing.json`);
  await poll('browser certificate download', 15000, async () => (await Bun.file(certificatePath).exists()) ? true : undefined);
  const verified = await mcp('relic_verify_certificate', { certificate_path: certificatePath, file_path: file, trusted_owner_identity_id: ownerKeys.identityId });
  assert.equal(verified.valid, true, JSON.stringify(verified));
  assert.equal(verified.content, 'match');
  const unchecked = await mcp('relic_verify_certificate', { certificate_path: certificatePath, file_path: file });
  assert.equal(unchecked.valid, false);
  assert.equal((unchecked.trust as { owner: string }).owner, 'unchecked');
  console.log('PUBLIC_CERTIFICATE downloaded=true trusted=valid untrusted=unchecked content=match');
  await Bun.write(file, 'Changed signing acceptance content\n');
  const lockedRepublish = await callMcpRaw(env, 'relic_republish', {relic_id: id, path: file, cover: false});
  assert.equal(lockedRepublish.isError, true);
  assert.equal(lockedRepublish.structured.code, 'version_locked');
  const mismatched = await mcp('relic_verify_certificate', {certificate_path: certificatePath, file_path: file, trusted_owner_identity_id: ownerKeys.identityId});
  assert.equal(mismatched.content, 'mismatch');
  assert.equal(mismatched.valid, false);
  const tamperedCertificate = JSON.parse(await readFile(certificatePath, 'utf8'));
  tamperedCertificate.signatures[0].statement.signer_email = 'changed@example.test';
  const tamperedPath = join(scratch, 'tampered-signing.json');
  await Bun.write(tamperedPath, JSON.stringify(tamperedCertificate));
  const tampered = await mcp('relic_verify_certificate', {certificate_path: tamperedPath, trusted_owner_identity_id: ownerKeys.identityId});
  assert.equal(tampered.valid, false);
  console.log('PUBLIC_LOCK republish=409 content_swap=mismatch field_flip=invalid');
  const privateFile = join(scratch, 'private-proof.txt');
  const privateMailStart = mails.length;
  await Bun.write(privateFile, 'Private signing acceptance path\n');
  const privatePublished = await mcp('relic_publish', { path: privateFile, private: true });
  const privateId = text(privatePublished.relic_id);
  const privateUrl = text(privatePublished.url);
  await goto(owner.browser, privateUrl);
  await waitForState(owner.browser, ['unlock'], 'private owner unlock');
  await click(owner.browser, '[data-action="private-unlock"]');
  await waitForOpened(owner.browser, 'private owner');
  const privateEnv: PrivateShareEnv = { ...env, reader: 'private-ana+signing@example.test' };
  const privateReader = await launchActor(privateEnv, 'private-ana', privateEnv.reader, true);
  actors.push(privateReader);
  const privateIdentity = await stepsFourAndFive(privateEnv, owner, privateReader, privateId, privateUrl, ownerKeys);
  denyOpenedFor = privateId;
  await stepSeven(privateEnv, owner, privateReader, privateId, privateUrl, privateIdentity);
  const privateRequest = await mcp('relic_request_signatures', {
    relic_id: privateId, signers: [{email: env.owner}, {email: privateEnv.reader}], order: 'parallel', require_opened: true,
  });
  assert.equal(privateRequest.status, 'open');
  const deniedOpened = await privateReader.browser.evaluate<{ status: number; code: string }>(`(async () => {
    const response = await fetch(${JSON.stringify(`/api/relics/${privateId}/signing/options`)}, {
      method:'POST', headers: {'content-type':'application/json'}, body:JSON.stringify({request_id:${JSON.stringify(privateRequest.request_id)}})
    });
    return {status:response.status, code:(await response.json()).code};
  })()`);
  assert.deepEqual(deniedOpened, {status:409, code:'signing_open_required'});
  denyOpenedFor = '';
  await goto(privateReader.browser, `${privateUrl}?refresh=1`);
  await waitForState(privateReader.browser, ['unlock'], 'private reader unlock');
  await click(privateReader.browser, '[data-action="private-unlock"]');
  await waitForOpened(privateReader.browser, 'private reader');
  const receipts = await poll('private opened receipt', 15000, async () => {
    const rows = (await store.listReceipts(privateId, 1)).filter(row => row.identityId === privateIdentity.identityId);
    return rows.some(row => row.kind === 'opened') && rows.some(row => row.kind === 'served') ? rows : undefined;
  });
  assert.equal(receipts.some(row => row.kind === 'served'), true);
  console.log('PRIVATE_RECEIPTS delivered=true opened=true require_opened_refused=409');
  for (const [actor, signerName] of [[privateReader, 'Private Ana'], [owner, 'Private Owner']] as const) {
    if (actor === owner) {
      await goto(owner.browser, `${privateUrl}?refresh=owner`);
      await waitForState(owner.browser, ['unlock'], 'private owner unlock for signing');
      await click(owner.browser, '[data-action="private-unlock"]');
      await waitForOpened(owner.browser, 'private owner signing');
    }
    await poll(`${signerName} sign control`, 15000, async () =>
      await actor.browser.evaluate<boolean>(`Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Sign here' && !b.disabled)`) ? true : undefined
    );
    await actor.browser.evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Sign here' && !b.disabled).click()`);
    await actor.browser.waitForSelector('.signing-panel input');
    await actor.browser.evaluate(`(() => {
      const panel = document.querySelector('.signing-panel');
      const name = panel.querySelector('input:not([type=checkbox])');
      name.value = ${JSON.stringify(signerName)};
      name.dispatchEvent(new Event('input', {bubbles:true}));
      panel.querySelector('input[type=checkbox]').click();
    })()`);
    await poll(`${signerName} signature prepared`, 15000, async () =>
      await actor.browser.evaluate<boolean>(`!!document.querySelector('.signing-panel .sign-row button.primary:not(:disabled)')`) ? true : undefined
    ).catch(async error => { throw new Error(`${error.message}: ${await actor.browser.evaluate<string>('document.body.innerText')}`); });
    await actor.browser.evaluate(`document.querySelector('.signing-panel .sign-row button.primary').click()`);
    await poll(`${signerName} signed`, 15000, async () => {
      const result = await mcp('relic_read_signing', { relic_id: privateId });
      const requests = result.requests as Array<{ signers: Array<{ email:string; status:string }> }>;
      return requests[0]?.signers.some(s => s.email === actor.email && s.status === 'signed') ? true : undefined;
    });
  }
  const privateCert = join(scratch, 'private-signing.json');
  await mcp('relic_read_signing', { relic_id: privateId, save_certificate_to: privateCert });
  const privateResult = await mcp('relic_verify_certificate', { certificate_path: privateCert, file_path: privateFile, trusted_owner_identity_id: ownerKeys.identityId });
  assert.equal(privateResult.valid, true, JSON.stringify(privateResult));
  assert.equal(privateResult.content, 'match');
  const parsedPrivateCert = JSON.parse(await readFile(privateCert, 'utf8'));
  assert.equal(parsedPrivateCert.signatures.length, 2);
  assert.ok(parsedPrivateCert.signatures.every((s: {identity_signature: string; receipts: {opened: unknown}}) => s.identity_signature && s.receipts.opened));
  console.log('PRIVATE_COMPLETE signers=2 identity_signatures=2 opened_receipts=2 certificate=valid');
  const privateMails = mails.slice(privateMailStart).filter(mail => mail.subject !== 'sign-in');
  assert.ok(privateMails.length > 0);
  assert.ok(privateMails.every(mail => !JSON.stringify(mail).includes('private-proof.txt')));
  const comments = await mcp('relic_read_comments', { relic_id: privateId });
  assert.ok(Array.isArray(comments.comments));
  for (const comment of comments.comments) {
    const status = await privateReader.browser.evaluate<number>(`fetch(${JSON.stringify(`/api/relics/${privateId}/comments/`)} + ${JSON.stringify(comment.comment_id)}, {method:'PATCH', headers:{'content-type':'application/json'}, body:JSON.stringify({resolved:true})}).then(r => r.status)`);
    assert.equal(status, 200);
  }
  await Bun.write(privateFile, 'Private signing acceptance path version two\n');
  const republished = await mcp('relic_republish', { relic_id: privateId, path: privateFile });
  assert.equal(republished.version, 2);
  await openPanel(owner, privateUrl);
  await clickPrivateControl(owner.browser, '[data-action="delete-relic"]');
  await owner.browser.waitForSelector('#delete-dialog[open]', 25000);
  await owner.browser.evaluate(`document.querySelector('input[data-delete-version="1"]').click()`);
  await click(owner.browser, '[data-action="confirm-delete"]');
  await poll('private locked version refusal', 15000, async () => deleteStatus ? true : undefined);
  assert.equal(deleteStatus, 409);
  assert.ok((await store.getRelic(privateId))?.lockedVersions?.includes(1));
  console.log('PRIVATE_LOCK republish=2 delete_locked_version=409 mails_name_title=false');
  const cancelFile = join(scratch, 'cancel-proof.txt');
  await Bun.write(cancelFile, 'Cancellation acceptance path\n');
  const cancelPublished = await mcp('relic_publish', { path: cancelFile, cover: false });
  const cancelId = text(cancelPublished.relic_id);
  const cancelRequest = await mcp('relic_request_signatures', { relic_id: cancelId, signers: [{email: env.reader}] });
  await mcp('relic_cancel_signing', { relic_id: cancelId, request_id: cancelRequest.request_id });
  const cancelState = JSON.parse(await readFile(statePath, 'utf8'));
  const cancelProof = encodeKey(await deriveShareProof(decodeKey(cancelState.relics[cancelId].key)));
  const cancelRefusal = await reader.browser.evaluate<{status: number; code: string}>(`(async () => {
    const response = await fetch(${JSON.stringify(`/api/relics/${cancelId}/signing/options`)}, {
      method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify({request_id:${JSON.stringify(cancelRequest.request_id)}, share_proof:${JSON.stringify(cancelProof)}})
    });
    return {status:response.status, code:(await response.json()).code};
  })()`);
  assert.deepEqual(cancelRefusal, {status:409, code:'signing_request_closed'});
  console.log('SIGNING_CANCEL options=409 code=signing_request_closed');
  throw new Error('remaining negative controls not yet exercised');
} catch (error) {
  console.error(`SIGNING_PATH_BLOCKED ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  for (const actor of actors) await actor.browser.close().catch(() => {});
  server.stop(true);
  await rm(scratch, { recursive: true, force: true });
}
