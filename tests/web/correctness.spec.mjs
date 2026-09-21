import { test, expect } from '@playwright/test';

test('canvas stays on the single live compositor during playback and pause', async ({ page, request }) => {
  const before = await (await request.get('/api/projects')).json();
  const beforeIds = new Set(before.map((project) => project.id));
  let projectId;
  await page.route('**/api/projects/*/preview-frame?**', async (route) => {
    await route.abort('failed');
  });

  await page.goto('/');
  try {
    await page.locator('.primary-button.large').click();
    await expect(page.locator('.editor-shell')).toBeVisible();
    await page.locator('.tool-rail button').filter({ hasText: /Elements|Öğeler/ }).click();
    await page.getByRole('button', { name: /White surface|Beyaz yüzey/ }).click();
    await expect(page.locator('.timeline-clip')).toHaveCount(1);

    await expect(page.locator('.output-preview-toggle')).toHaveCount(0);
    await expect(page.locator('.output-preview-frame')).toHaveCount(0);
    await expect(page.locator('.canvas-frame .preview-media')).toBeVisible();
    await page.getByRole('button', { name: /^(Play|Oynat)$/ }).click();
    await page.waitForTimeout(150);
    await page.getByRole('button', { name: /^(Pause|Duraklat)$/ }).click();
    await expect(page.locator('.canvas-frame .preview-media')).toBeVisible();

    await page.getByRole('button', { name: /Export|Dışa aktar/ }).click();
    await expect(page.getByLabel(/Output resolution|Çıktı çözünürlüğü/).locator('option[value="2K"]')).toHaveText(/1440p QHD · 2560 × 1440/);
    await page.getByLabel(/Output frame rate|Çıktı kare hızı/).selectOption('60');
    await expect(page.locator('.export-warning')).toContainText(/30 FPS.*60 FPS/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.preview-time-fps')).toHaveText('30 FPS');
    await expect(page.getByLabel(/Project frame rate|Proje kare hızı/)).toHaveValue('30');

    const projects = await (await request.get('/api/projects')).json();
    projectId = projects.find((project) => !beforeIds.has(project.id))?.id;
  } finally {
    if (projectId) {
      const deleted = await request.delete(`/api/projects/${projectId}`);
      if (deleted.ok()) {
        const trashId = (await deleted.json()).trashId;
        if (trashId) await request.delete(`/api/trash/${trashId}`);
      }
    }
  }
});

test('dashboard quick cards and advertised editor shortcuts execute their labeled actions', async ({ page, request }) => {
  const beforeResponse = await request.get('/api/projects');
  const beforeIds = new Set(beforeResponse.ok() ? (await beforeResponse.json()).map((project) => project.id) : []);
  let projectId;
  await page.goto('/');
  await expect(page.locator('.dashboard-command-strip')).toBeVisible();

  try {
    const quickCards = page.locator('.dashboard-command-strip .command-card');
    const chooserPromise = page.waitForEvent('filechooser');
    await quickCards.nth(1).click();
    await chooserPromise;

    await quickCards.first().click();
    await expect(page.locator('.editor-shell')).toBeVisible();
    const afterResponse = await request.get('/api/projects');
    const after = await afterResponse.json();
    projectId = after.find((project) => !beforeIds.has(project.id))?.id;
    expect(projectId).toBeTruthy();

    await page.locator('.tool-rail button').filter({ hasText: /Text|Metin/ }).click();
    await expect(page.locator('.tool-rail button.active')).toContainText(/Text|Metin/);
    await page.keyboard.press('m');
    await expect(page.locator('.tool-rail button.active')).toContainText(/Media|Medya/);

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+e' : 'Control+e');
    await expect(page.locator('.export-modal')).toBeVisible();
  } finally {
    if (projectId) {
      const deletedResponse = await request.delete(`/api/projects/${projectId}`);
      if (deletedResponse.ok()) {
        const deleted = await deletedResponse.json();
        if (deleted.trashId) await request.delete(`/api/trash/${deleted.trashId}`);
      }
    }
  }
});

test('timeline seeking continues from the clicked position during playback and empty space clears selection', async ({ page, request }) => {
  const fixtureName = `Playback seek ${Date.now()}`;
  const beforeResponse = await request.get('/api/projects');
  const beforeIds = new Set(beforeResponse.ok() ? (await beforeResponse.json()).map((project) => project.id) : []);
  let projectId;

  await page.goto('/');
  try {
    await page.locator('.primary-button.large').click();
    await expect(page.locator('.editor-shell')).toBeVisible();
    const inspectorBox = await page.locator('.inspector').boundingBox();
    const timelineBox = await page.locator('.timeline-pro').boundingBox();
    expect(inspectorBox).toBeTruthy();
    expect(timelineBox).toBeTruthy();
    expect(Math.abs((inspectorBox.y + inspectorBox.height) - (timelineBox.y + timelineBox.height))).toBeLessThanOrEqual(2);
    expect(timelineBox.x + timelineBox.width).toBeLessThanOrEqual(inspectorBox.x + 2);
    await page.locator('.project-name-input').fill(fixtureName);
    await page.locator('.tool-rail button').filter({ hasText: /Elements|Öğeler/ }).click();
    const whiteSurface = page.locator('.stock-media-card').filter({ hasText: /White surface|Beyaz yüzey/ });
    await whiteSurface.click();
    await expect(page.locator('.timeline-clip')).toHaveCount(1);
    await whiteSurface.click();
    await expect(page.locator('.timeline-clip')).toHaveCount(2);

    const snapToggle = page.locator('.snap-toggle');
    await expect(snapToggle).toHaveAttribute('aria-pressed', 'true');
    const snapOnIcon = await snapToggle.locator('svg').innerHTML();
    const clips = page.locator('.timeline-clip');
    await expect(clips.first()).toHaveAttribute('aria-pressed', 'false');
    await expect(clips.nth(1)).toHaveAttribute('aria-pressed', 'true');
    const firstClipWidth = await clips.first().evaluate((element) => Number.parseFloat(element.style.width));
    const initialSecondClipLeft = await clips.nth(1).evaluate((element) => Number.parseFloat(element.style.left));
    const dragClipBy = async (clip, deltaX) => {
      const box = await clip.boundingBox();
      expect(box).toBeTruthy();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + deltaX, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
    };
    await dragClipBy(clips.nth(1), 30);
    let secondClipLeft = await clips.nth(1).evaluate((element) => Number.parseFloat(element.style.left));
    expect(secondClipLeft).toBeGreaterThan(initialSecondClipLeft + 15);
    await dragClipBy(clips.nth(1), firstClipWidth + 5 - secondClipLeft);
    secondClipLeft = await clips.nth(1).evaluate((element) => Number.parseFloat(element.style.left));
    expect(secondClipLeft).toBeCloseTo(firstClipWidth, 1);

    await snapToggle.click();
    await expect(snapToggle).toHaveAttribute('aria-pressed', 'false');
    expect(await snapToggle.locator('svg').innerHTML()).not.toBe(snapOnIcon);
    await dragClipBy(clips.nth(1), 5);
    secondClipLeft = await clips.nth(1).evaluate((element) => Number.parseFloat(element.style.left));
    expect(secondClipLeft).toBeGreaterThan(firstClipWidth + 2);
    await snapToggle.click();
    await expect(snapToggle).toHaveAttribute('aria-pressed', 'true');

    const clip = page.locator('.timeline-clip').first();
    await clip.click();
    await expect(clip).toHaveAttribute('aria-pressed', 'true');
    const timecode = page.locator('.preview-timecode-display');
    await expect(timecode).toBeVisible();
    await expect(timecode).toHaveText(/^\d{2}:\d{2}:\d{2}:\d{2}$/);
    await expect(timecode.locator('b')).toBeVisible();
    const frameStyle = await timecode.locator('b').evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, radius: style.borderRadius };
    });
    expect(frameStyle.background).toBe('rgba(0, 0, 0, 0)');
    expect(frameStyle.radius).toBe('0px');
    const playButton = page.locator('.play-button');
    await playButton.click();
    await expect(playButton).toHaveAttribute('aria-label', /Pause|Duraklat/);

    const ruler = page.locator('.ruler');
    const rulerBox = await ruler.boundingBox();
    expect(rulerBox).toBeTruthy();
    const seekX = Math.min(220, rulerBox.width * 0.6);
    await ruler.click({ position: { x: seekX, y: rulerBox.height / 2 } });
    await page.waitForTimeout(250);

    const playheadLeft = await page.locator('.playhead').evaluate((element) => Number.parseFloat(element.style.left));
    expect(playheadLeft).toBeGreaterThanOrEqual(seekX - 5);
    await expect(playButton).toHaveAttribute('aria-label', /Pause|Duraklat/);

    await playButton.click();
    const emptyTrack = page.locator('.track-row:not(:has(.timeline-clip))').first();
    await expect(emptyTrack).toBeVisible();
    await emptyTrack.click({ position: { x: 120, y: 12 } });
    await expect(clip).toHaveAttribute('aria-pressed', 'false');

    const projects = await (await request.get('/api/projects')).json();
    projectId = projects.find((project) => !beforeIds.has(project.id))?.id;
    expect(projectId).toBeTruthy();
  } finally {
    if (projectId) {
      const deletedResponse = await request.delete(`/api/projects/${projectId}`);
      if (deletedResponse.ok()) {
        const deleted = await deletedResponse.json();
        if (deleted.trashId) await request.delete(`/api/trash/${deleted.trashId}`);
      }
    }
  }
});

test('editor shortcuts are fixed and ignore attempted settings overrides', async ({ page, request }) => {
  test.setTimeout(45_000);
  const fixtureName = `Shortcut persistence ${Date.now()}`;
  const beforeResponse = await request.get('/api/projects');
  const beforeIds = new Set(beforeResponse.ok() ? (await beforeResponse.json()).map((project) => project.id) : []);
  const settingsResponse = await request.get('/api/settings');
  expect(settingsResponse.ok()).toBeTruthy();
  const initialSettings = await settingsResponse.json();
  const attemptedOverride = { ...initialSettings, shortcuts: { ...initialSettings.shortcuts, togglePlayback: 'P' } };
  let projectId;

  await request.put('/api/settings', { data: attemptedOverride });
  try {
    await page.goto('/');
    await page.locator('.primary-button.large').click();
    await expect(page.locator('.editor-shell')).toBeVisible();
    await page.locator('.project-name-input').fill(fixtureName);
    await page.locator('.tool-rail button').filter({ hasText: /Elements|Öğeler/ }).click();
    await page.getByRole('button', { name: /White surface|Beyaz yüzey/ }).click();
    await expect(page.locator('.timeline-clip')).toHaveCount(1);

    await page.locator('.editor-settings').click();
    await page.locator('.settings-tabs button').filter({ hasText: /Shortcuts|Kısayollar/ }).click();
    const playbackShortcut = page.locator('.shortcut-setting-row kbd').first();
    await expect(playbackShortcut).toHaveText('Space');
    await expect(page.locator('.shortcut-setting-row input')).toHaveCount(0);
    await page.locator('.settings-modal').getByRole('button', { name: /Close|Kapat/i }).click();

    const playButton = page.locator('.play-button');
    await page.locator('.preview-stage').click({ position: { x: 8, y: 8 } });
    await expect(playButton).toHaveAttribute('aria-label', /Play|Oynat/);
    await page.keyboard.press('p');
    await expect(playButton).toHaveAttribute('aria-label', /Play|Oynat/);
    await page.keyboard.press('Space');
    await expect(playButton).toHaveAttribute('aria-label', /Pause|Duraklat/);

    const persistedSettings = await (await request.get('/api/settings')).json();
    expect(persistedSettings.shortcuts.togglePlayback).toBe('Space');
    await expect(page.locator('.save-indicator')).toContainText(/Saved|Kaydedildi/i, { timeout: 10_000 });
    const projects = await (await request.get('/api/projects')).json();
    projectId = projects.find((project) => !beforeIds.has(project.id))?.id;
    expect(projectId).toBeTruthy();

    await page.reload();
    await page.locator('article').filter({ hasText: fixtureName }).getByRole('button').first().click();
    await expect(page.locator('.editor-shell')).toBeVisible();
    await expect(page.locator('.route-transition')).toHaveCount(0);
    await page.locator('.preview-stage').click({ position: { x: 8, y: 8 } });
    await expect(playButton).toHaveAttribute('aria-label', /Play|Oynat/);
    await page.keyboard.press('Space');
    await expect(page.locator('.play-button')).toHaveAttribute('aria-label', /Pause|Duraklat/);
    await page.keyboard.press('p');
    await expect(page.locator('.play-button')).toHaveAttribute('aria-label', /Pause|Duraklat/);

    await page.locator('.editor-settings').click();
    await page.locator('.settings-tabs button').filter({ hasText: /Shortcuts|Kısayollar/ }).click();
    await expect(page.locator('.shortcut-setting-row kbd').first()).toHaveText('Space');
  } finally {
    await request.put('/api/settings', { data: initialSettings });
    if (projectId) {
      const deletedResponse = await request.delete(`/api/projects/${projectId}`);
      if (deletedResponse.ok()) {
        const deleted = await deletedResponse.json();
        if (deleted.trashId) await request.delete(`/api/trash/${deleted.trashId}`);
      }
    }
  }
});

test('an active CLI session makes an open web project read-only and shows its owner', async ({ page, request }) => {
  const createdResponse = await request.post('/api/projects', { data: { name: `CLI web lock ${Date.now()}` } });
  expect(createdResponse.ok()).toBeTruthy();
  const created = await createdResponse.json();
  let token;
  let trashId;
  try {
    await page.goto('/');
    await page.locator('article').filter({ hasText: created.name }).getByRole('button').first().click();
    await expect(page.locator('.editor-shell')).toBeVisible();

    const leaseResponse = await request.post(`/api/projects/${created.id}/access`, {
      data: { ownerId: 'playwright-cli', ownerLabel: 'Playwright AI CLI', client: 'cli', ttlMs: 15_000, force: false },
    });
    expect(leaseResponse.ok()).toBeTruthy();
    token = (await leaseResponse.json()).token;
    const lock = page.getByRole('alert');
    await expect(lock).toBeVisible();
    await expect(lock).toContainText('Playwright AI CLI');
    await expect(page.locator('.project-name-input').click({ timeout: 1_000 })).rejects.toThrow();

    const blockedSave = await request.patch(`/api/projects/${created.id}`, { data: { name: 'must not save', revision: created.revision } });
    expect(blockedSave.status()).toBe(423);
    await request.delete(`/api/projects/${created.id}/access`, { headers: { 'x-cutloc-access-token': token } });
    token = undefined;
    await expect(lock).toBeHidden();
    await page.locator('.project-name-input').fill('Web access returned');
    await expect(page.locator('.save-indicator')).toContainText(/Saved|Kaydedildi/i);
  } finally {
    if (token) await request.delete(`/api/projects/${created.id}/access`, { headers: { 'x-cutloc-access-token': token } });
    const deleted = await request.delete(`/api/projects/${created.id}`);
    if (deleted.ok()) trashId = (await deleted.json()).trashId;
    if (trashId) await request.delete(`/api/trash/${trashId}`);
  }
});

test('two tabs merge independent edits and surface same-property conflicts', async ({ browser, request }, testInfo) => {
  test.setTimeout(60_000);
  const fixtureName = `Multi tab conflict ${Date.now()}`;
  const baseURL = testInfo.project.use.baseURL;
  const contextA = await browser.newContext({ baseURL });
  const contextB = await browser.newContext({ baseURL });
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  let projectId;
  const saved = /All changes saved|T[uü]m de[gğ]i[şs]iklikler kaydedildi/i;

  try {
    await pageA.goto('/');
    await pageA.locator('.primary-button.large').click();
    await pageA.locator('.project-name-input').fill(fixtureName);
    await pageA.locator('.tool-rail button').filter({ hasText: /Elements|Öğeler/ }).click();
    await pageA.getByRole('button', { name: /White surface|Beyaz y[uü]zey/ }).click();
    await expect(pageA.locator('.save-indicator')).toContainText(/Saved|Kaydedildi/i, { timeout: 10_000 });

    const projectsResponse = await request.get('/api/projects');
    projectId = (await projectsResponse.json()).find((project) => project.name === fixtureName)?.id;
    expect(projectId).toBeTruthy();
    await expect.poll(async () => {
      const detail = await (await request.get(`/api/projects/${projectId}`)).json();
      return detail.tracks.flatMap((track) => track.clips).length;
    }, { timeout: 10_000 }).toBe(1);

    await pageB.goto('/');
    await pageB.locator('article').filter({ hasText: fixtureName }).getByRole('button').first().click();
    await expect(pageB.locator('.timeline-clip')).toHaveCount(1);
    await pageA.locator('.timeline-clip').click();
    await pageB.locator('.timeline-clip').click();

    const scaleA = pageA.getByRole('spinbutton', { name: /Scale|Ölçek/ });
    const positionXB = pageB.getByRole('spinbutton', { name: /^X(?: px)?$/ });
    await scaleA.fill('1.25');
    await scaleA.press('Tab');
    await expect(pageA.locator('.save-indicator')).toContainText(/Saved|Kaydedildi/i, { timeout: 10_000 });
    await positionXB.fill('42');
    await positionXB.press('Tab');
    await expect(pageB.locator('.save-indicator')).toContainText(/Saved|Kaydedildi/i, { timeout: 10_000 });

    let detail = await (await request.get(`/api/projects/${projectId}`)).json();
    let clip = detail.tracks.flatMap((track) => track.clips)[0];
    expect(clip.transform.scale).toBe(1.25);
    expect(clip.transform.x).toBe(42);

    await scaleA.fill('1.5');
    await scaleA.press('Tab');
    await expect(pageA.locator('.save-indicator')).toContainText(/Saved|Kaydedildi/i, { timeout: 10_000 });
    const scaleB = pageB.getByRole('spinbutton', { name: /Scale|Ölçek/ });
    await scaleB.fill('1.75');
    await scaleB.press('Tab');
    await expect(pageB.locator('.save-indicator')).toContainText(/Save error|Kaydetme hatas[ıi]/i, { timeout: 10_000 });

    detail = await (await request.get(`/api/projects/${projectId}`)).json();
    clip = detail.tracks.flatMap((track) => track.clips)[0];
    expect(clip.transform.scale).toBe(1.5);
    expect(clip.transform.x).toBe(42);
  } finally {
    await contextA.close();
    await contextB.close();
    if (projectId) {
      const deletedResponse = await request.delete(`/api/projects/${projectId}`);
      if (deletedResponse.ok()) {
        const deleted = await deletedResponse.json();
        if (deleted.trashId) await request.delete(`/api/trash/${deleted.trashId}`);
      }
    }
  }
});

test('two tabs surface delete-versus-edit conflicts without deleting the saved clip', async ({ browser, request }, testInfo) => {
  test.setTimeout(60_000);
  const fixtureName = `Delete edit conflict ${Date.now()}`;
  const baseURL = testInfo.project.use.baseURL;
  const contextA = await browser.newContext({ baseURL });
  const contextB = await browser.newContext({ baseURL });
  const pageA = await contextA.newPage(); const pageB = await contextB.newPage();
  let projectId;
  const saved = /All changes saved|T[uü]m de[gğ]i[şs]iklikler kaydedildi/i;
  try {
    await pageA.goto('/'); await pageA.locator('.primary-button.large').click();
    await pageA.locator('.project-name-input').fill(fixtureName);
    await pageA.locator('.tool-rail button').filter({ hasText: /Elements|Öğeler/ }).click();
    await pageA.getByRole('button', { name: /White surface|Beyaz y[uü]zey/ }).click();
    await expect(pageA.locator('.save-indicator')).toContainText(/Saved|Kaydedildi/i, { timeout: 10_000 });
    projectId = (await (await request.get('/api/projects')).json()).find((project) => project.name === fixtureName)?.id;
    expect(projectId).toBeTruthy();
    await expect.poll(async () => {
      const detailResponse = await request.get(`/api/projects/${projectId}`);
      if (!detailResponse.ok()) return 0;
      const detail = await detailResponse.json();
      return detail.tracks.flatMap((track) => track.clips).length;
    }, { timeout: 10_000 }).toBe(1);
    await pageB.goto('/'); await pageB.locator('article').filter({ hasText: fixtureName }).getByRole('button').first().click();
    await expect(pageB.locator('.timeline-clip')).toHaveCount(1);
    await pageA.locator('.timeline-clip').click();
    const scale = pageA.getByRole('spinbutton', { name: /Scale|Ölçek/ });
    await scale.fill('1.5'); await scale.press('Tab');
    await expect(pageA.locator('.save-indicator')).toContainText(/Saved|Kaydedildi/i, { timeout: 10_000 });
    await pageB.locator('.timeline-clip').click({ button: 'right' });
    await pageB.getByRole('menuitem', { name: /Delete|Sil/i }).click();
    await expect(pageB.locator('.save-indicator')).toContainText(/Save error|Kaydetme hatas[ıi]/i, { timeout: 10_000 });
    const detail = await (await request.get(`/api/projects/${projectId}`)).json();
    expect(detail.tracks.flatMap((track) => track.clips)).toHaveLength(1);
    expect(detail.tracks.flatMap((track) => track.clips)[0].transform.scale).toBe(1.5);
  } finally {
    await contextA.close(); await contextB.close();
    if (projectId) { const deleted = await request.delete(`/api/projects/${projectId}`); if (deleted.ok()) await request.delete(`/api/trash/${(await deleted.json()).trashId}`); }
  }
});

test('server refresh cannot resurrect a locally deleted asset', async ({ page, request }) => {
  test.setTimeout(45_000);
  const fixtureName = `Deleted asset refresh ${Date.now()}`;
  let projectId;
  let clockInstalled = false;
  await page.goto('/');
  try {
    await page.locator('.primary-button.large').click();
    await page.locator('.project-name-input').fill(fixtureName);
    await page.locator('.tool-rail button').filter({ hasText: /Elements|Öğeler/ }).click();
    await page.getByRole('button', { name: /White surface|Beyaz y[uü]zey/ }).click();
    await expect(page.locator('.save-indicator')).toContainText(/Saved|Kaydedildi/i, { timeout: 10_000 });
    const projects = await (await request.get('/api/projects')).json();
    projectId = projects.find((project) => project.name === fixtureName)?.id;
    expect(projectId).toBeTruthy();
    await expect.poll(async () => (await (await request.get(`/api/projects/${projectId}`)).json()).assets.length, { timeout: 10_000 }).toBe(1);

    await page.locator('.tool-rail button').filter({ hasText: /Media|Medya/ }).click();
    await expect(page.locator('.asset-item.pro')).toHaveCount(1);
    await page.clock.install();
    clockInstalled = true;
    await page.evaluate(() => (document.querySelector('.asset-item.pro .asset-dots'))?.click());
    await page.evaluate(() => {
      const removeItem = [...document.querySelectorAll('[role="menuitem"]')].find((item) => /Remove from project|Projeden kaldır/i.test(item.textContent ?? ''));
      if (!(removeItem instanceof HTMLElement)) throw new Error('Remove media menu item did not open');
      removeItem.click();
    });
    await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const confirmButton = dialog && [...dialog.querySelectorAll('button')].find((button) => /Remove from project|Projeden kaldır/i.test(button.textContent ?? ''));
      if (!(confirmButton instanceof HTMLElement)) throw new Error('Remove media confirmation did not open');
      confirmButton.click();
    });
    await expect(page.locator('.asset-item.pro')).toHaveCount(0);

    const current = await (await request.get(`/api/projects/${projectId}`)).json();
    const remote = { ...current, assets: current.assets.map((asset) => ({ ...asset, name: `${asset.name} refreshed` })), revision: current.revision };
    expect((await request.patch(`/api/projects/${projectId}`, { data: remote })).ok()).toBeTruthy();
    await page.evaluate(() => (document.querySelector('.media-panel-heading .panel-more'))?.click());
    await page.evaluate(() => {
      const refreshItem = [...document.querySelectorAll('[role="menuitem"]')].find((item) => /Refresh library|Kütüphaneyi yenile/i.test(item.textContent ?? ''));
      if (!(refreshItem instanceof HTMLElement)) throw new Error('Refresh library menu item did not open');
      refreshItem.click();
    });
    await expect(page.locator('.asset-item.pro')).toHaveCount(0);
    await page.clock.runFor(700);
    await page.clock.resume();
    clockInstalled = false;
    await expect.poll(async () => (await (await request.get(`/api/projects/${projectId}`)).json()).assets.length, { timeout: 10_000 }).toBe(0);

    await page.reload();
    await page.locator('article').filter({ hasText: fixtureName }).getByRole('button').first().click();
    await page.locator('.tool-rail button').filter({ hasText: /Media|Medya/ }).click();
    await expect(page.locator('.asset-item.pro')).toHaveCount(0);
    await expect(page.locator('.timeline-clip')).toHaveCount(0);
  } finally {
    if (clockInstalled) await page.clock.resume().catch(() => undefined);
    if (projectId) {
      const deletedResponse = await request.delete(`/api/projects/${projectId}`);
      if (deletedResponse.ok()) {
        const deleted = await deletedResponse.json();
        if (deleted.trashId) await request.delete(`/api/trash/${deleted.trashId}`);
      }
    }
  }
});
