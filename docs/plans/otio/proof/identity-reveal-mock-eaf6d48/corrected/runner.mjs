var otioMockIdentityReceipt = await otioRevealMockTab.run(async ({ page }) => {
  const origin = new URL(page.url()).origin;
  const out = '/var/folders/cx/smp6389s35gds6b_bfywv_8h0000gn/T/otio-reveal-mock-corrected-qSlTRh';
  const results = [];
  for (const phase of ['before', 'after']) {
    await page.goto(origin + '/' + phase);
    await page.evaluate(`(() => {
      const state = JSON.parse(localStorage.getItem('relik.otio.viewer.mock.v1'));
      state.selection = {track:'video-2-duplicate',start:0,end:0};
      state.active = null; state.mode = 'point'; state.theme = 'light'; state.version = 2;
      state.comments = Array.from({length:40}, (_,i) => ({id:'identity-'+String(i+1).padStart(2,'0'),number:i+1,version:2,track:'video-2-duplicate',start:0,end:0,body:'Coincident point review '+(i+1),author:'publisher',resolved:false,replies:[]}));
      localStorage.setItem('relik.otio.viewer.mock.v1', JSON.stringify(state));
    })()`);
    await page.reload();
    await page.evaluate('document.fonts.ready');
    await page.click('#comments-toggle');
    for (const edge of ['first', 'last']) {
      const pre = await page.evaluate(`(async () => {
        const edge = ${JSON.stringify(edge)};
        const band = document.querySelector('.comment-band[data-track-id="video-2-duplicate"]');
        const body = band.parentElement;
        const marks = [...band.querySelectorAll('.otio-comment-mark')].sort((a,b) => a.getBoundingClientRect().top-b.getBoundingClientRect().top);
        const mark = edge === 'first' ? marks[0] : marks.at(-1);
        const expectedId = mark.dataset.commentId;
        const bodyAbsoluteTop = body.getBoundingClientRect().top + scrollY;
        window.scrollTo({top:bodyAbsoluteTop + (edge === 'first' ? 80 : 1),behavior:'instant'});
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const row = [...document.querySelectorAll('#thread-list > .comment')].find(node => node.dataset.commentId === expectedId);
        const target = row.querySelector('.comment-target');
        const list = document.querySelector('#thread');
        const targetBefore = target.getBoundingClientRect();
        const listBefore = list.getBoundingClientRect();
        list.scrollTop += targetBefore.top + targetBefore.height/2 - (listBefore.top + listBefore.height/2);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const markRect = mark.getBoundingClientRect();
        const bodyRect = body.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const center = {x:targetRect.left+targetRect.width/2,y:targetRect.top+targetRect.height/2};
        const rowHit = document.elementFromPoint(center.x,center.y)?.closest('#thread-list > .comment')?.dataset.commentId ?? null;
        const markCenter = {x:markRect.left+markRect.width/2,y:markRect.top+markRect.height/2};
        const bodySpansBoth = bodyRect.top < 0 && bodyRect.bottom > innerHeight;
        const targetOffscreen = markCenter.y < 0 || markCenter.y >= innerHeight;
        window.__otioMockSidebarClick = null;
        target.addEventListener('click', event => {window.__otioMockSidebarClick={id:row.dataset.commentId,trusted:event.isTrusted};}, {capture:true,once:true});
        const expectedComment = JSON.parse(localStorage.getItem('relik.otio.viewer.mock.v1')).comments.find(comment => comment.id === expectedId);
        return {expectedId,expectedComment,center,markCenter,mark:markRect.toJSON(),body:bodyRect.toJSON(),band:band.getBoundingClientRect().toJSON(),viewport:{width:innerWidth,height:innerHeight},document:{scrollY,scrollTop:document.scrollingElement.scrollTop,clientHeight:document.documentElement.clientHeight,scrollHeight:document.documentElement.scrollHeight},sidebarScrollTop:list.scrollTop,rowHit,targetOffscreen,bodySpansBoth,preconditionsOk:innerWidth===900&&innerHeight===900&&targetOffscreen&&(edge==='first'||bodySpansBoth)&&rowHit===expectedId};
      })()`);
      await page.screenshot({path:out+'/'+phase+'-'+edge+'-before.png',fullPage:false});
      if (pre.preconditionsOk) {
        await page.mouse.move(pre.center.x,pre.center.y);
        await page.mouse.down({button:'left'});
        await page.mouse.up({button:'left'});
      }
      await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const post = await page.evaluate(`(() => {
        const expectedId = ${JSON.stringify(pre.expectedId)};
        const mark = [...document.querySelectorAll('.comment-band .otio-comment-mark')].find(node => node.dataset.commentId === expectedId);
        const row = [...document.querySelectorAll('#thread-list > .comment')].find(node => node.dataset.commentId === expectedId);
        const box = mark.getBoundingClientRect();
        const label = mark.closest('.track-row').querySelector('.track-label').getBoundingClientRect();
        const timeline = document.querySelector('#timeline-scroll');
        const timelineBox = timeline.getBoundingClientRect();
        const workbenchBox = document.querySelector('.workbench').getBoundingClientRect();
        const center = {x:box.left+box.width/2,y:box.top+box.height/2};
        const contentWindow = {left:Math.max(0,label.right),right:Math.min(innerWidth,timelineBox.right,workbenchBox.right),top:0,bottom:innerHeight};
        const hitId = document.elementFromPoint(center.x,center.y)?.closest('.otio-comment-mark')?.dataset.commentId ?? null;
        const state = JSON.parse(localStorage.getItem('relik.otio.viewer.mock.v1'));
        const comment = state.comments.find(item => item.id === expectedId);
        return {center,mark:box.toJSON(),contentWindow,inside:center.x>=contentWindow.left&&center.x<contentWindow.right&&center.y>=contentWindow.top&&center.y<contentWindow.bottom,hitId,click:window.__otioMockSidebarClick,activeId:state.active,markActive:mark.classList.contains('is-active'),rowActive:row.classList.contains('is-active'),comment,selection:state.selection,markLeft:mark.style.left,document:{scrollY,scrollTop:document.scrollingElement.scrollTop,clientHeight:document.documentElement.clientHeight,scrollHeight:document.documentElement.scrollHeight},timelineScrollLeft:timeline.scrollLeft};
      })()`);
      await page.screenshot({path:out+'/'+phase+'-'+edge+'-after.png',fullPage:false});
      const problems = [];
      if (!pre.preconditionsOk) problems.push('Unmet preconditions');
      if (post.click?.id !== pre.expectedId || post.click?.trusted !== true) problems.push('Trusted sidebar target identity mismatch');
      if (post.activeId !== pre.expectedId || !post.markActive || !post.rowActive) problems.push('Persisted or active identity mismatch');
      if (!post.inside || post.hitId !== pre.expectedId) problems.push('Intended mark center not exposed and hit-owned');
      if (JSON.stringify(post.comment) !== JSON.stringify(pre.expectedComment)) problems.push('Comment track/time/content changed');
      if (post.selection?.track !== pre.expectedComment.track || post.selection?.start !== 0 || post.selection?.end !== 0 || post.markLeft !== '0%') problems.push('Selection or temporal geometry changed');
      results.push({phase,edge,pre,post,problems,success:problems.length===0});
    }
  }
  return {viewport:{width:900,height:900},oldProduct:'704379d',repairedProduct:'eaf6d48',defaultSeedFileUnchanged:true,isolatedSeedCount:40,results,negativeDetected:results.some(result=>result.phase==='before'&&result.pre.preconditionsOk&&!result.success),positivePassed:results.filter(result=>result.phase==='after').length===2&&results.filter(result=>result.phase==='after').every(result=>result.success)};
});
await Bun.write(otioRevealMockOut+'/mock-sidebar-identity.json',JSON.stringify(otioMockIdentityReceipt,null,2)+'\n');
console.log(JSON.stringify({negativeDetected:otioMockIdentityReceipt.negativeDetected,positivePassed:otioMockIdentityReceipt.positivePassed,cases:otioMockIdentityReceipt.results.map(result=>({phase:result.phase,edge:result.edge,id:result.pre.expectedId,preconditionsOk:result.pre.preconditionsOk,hitId:result.post.hitId,activeId:result.post.activeId,success:result.success,problems:result.problems})),out:otioRevealMockOut},null,2));
if(!otioMockIdentityReceipt.negativeDetected||!otioMockIdentityReceipt.positivePassed)throw new Error('Mock sidebar reveal qualification failed; first receipts retained.');
