import assert from 'node:assert/strict';

export async function checkTree(
  evaluate: (expression: string) => Promise<unknown>,
  viewport: (width: number, height: number) => Promise<void>,
  capture: (label: string, dark: boolean) => Promise<void>
): Promise<void> {
  await capture('desktop-light', false);
  await capture('desktop-dark', true);
  assert.equal(
    await evaluate(
      `(async()=>{history.back(); for(let i=0;i<300;i++){if(document.querySelector('.folder-breadcrumb')?.textContent.includes('a.json'))return true;await new Promise(r=>setTimeout(r,20))}return false})()`
    ),
    true
  );
  assert.equal(
    await evaluate(`location.pathname + location.search + location.hash`),
    '/'
  );
  assert.equal(
    await evaluate(
      `(()=>{const row=document.querySelector('.folder-row[title="data"]');row.focus();row.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));const collapsed=document.querySelector('.folder-row[title="data"]').getAttribute('aria-expanded')==='false';document.querySelector('.folder-row[title="data"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));return collapsed && document.querySelector('.folder-row[title="data"]').getAttribute('aria-expanded')==='true'})()`
    ),
    true
  );
  await viewport(390, 844);
  assert.equal(
    await evaluate(`document.documentElement.scrollWidth <= 390`),
    true
  );
  assert.equal(
    await evaluate(
      `(()=>{document.querySelector('.folder-toggle').click();return document.querySelector('.folder-pane').getAttribute('role')==='dialog'})()`
    ),
    true
  );
  assert.equal(
    await evaluate(
      `Array.from(document.querySelectorAll('.folder-row')).every(row=>row.getBoundingClientRect().height >= 44)`
    ),
    true
  );
  await capture('sheet-light', false);
  await capture('sheet-dark', true);
  assert.equal(
    await evaluate(
      `(async()=>{document.querySelector('.folder-row[title="README.md"]').click(); for(let i=0;i<300;i++){if(document.querySelector('.folder-breadcrumb')?.textContent.includes('README.md'))return !document.querySelector('.folder-pane').dataset.open;await new Promise(r=>setTimeout(r,20))}return false})()`
    ),
    true
  );
  await capture('mobile-light', false);
  await capture('mobile-dark', true);
  assert.equal(
    await evaluate(
      `(async()=>{await window.mountLargeFolder();return document.querySelectorAll('.folder-row').length <= 120})()`
    ),
    true
  );
  assert.equal(
    await evaluate(
      `(async()=>{document.querySelector('.folder-toggle').click();document.querySelector('.folder-row').focus();for(let i=0;i<90;i++)document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));await new Promise(r=>setTimeout(r,50));return document.activeElement.classList.contains('folder-row') && document.activeElement.getAttribute('title').endsWith('file-0082.txt')})()`
    ),
    true
  );
  assert.equal(
    await evaluate(
      `(()=>{const input=document.querySelector('.folder-filter');input.value='file-1999';input.dispatchEvent(new Event('input',{bubbles:true}));return !!document.querySelector('.folder-row[title="a/b/c/d/e/f/g/h/file-1999.txt"]') && document.querySelectorAll('.folder-row').length <= 120})()`
    ),
    true
  );
  console.log('MULTI_FILE_STAGE open-tree OK');
}
