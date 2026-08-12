import { test, expect } from '@playwright/test';

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

test('two tabs merge independent edits and surface same-property conflicts', async ({ browser, request }) => {
  test.setTimeout(60_000);
  const fixtureName = `Multi tab conflict ${Date.now()}`;
  const contextA = await browser.newContext({ baseURL: 'http://127.0.0.1:5173' });
  const contextB = await browser.newContext({ baseURL: 'http://127.0.0.1:5173' });
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  let projectId;
  const saved = /All changes saved|T[uü]m de[gğ]i[şs]iklikler kaydedildi/i;

  try {
    await pageA.goto('/');
    await pageA.locator('.primary-button.large').click();
    await pageA.locator('.project-name-input').fill(fixtureName);
    await pageA.getByRole('tab', { name: /Stock|Stok/ }).click();
    await pageA.getByRole('button', { name: /White surface|Beyaz y[uü]zey/ }).click();
    await expect(pageA.locator('.editor-statusbar')).toContainText(saved, { timeout: 10_000 });

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

    const scaleA = pageA.getByRole('spinbutton', { name: 'Scale' });
    const positionXB = pageB.getByRole('spinbutton', { name: /^X$/ });
    await scaleA.fill('1.25');
    await scaleA.press('Tab');
    await expect(pageA.locator('.editor-statusbar')).toContainText(saved, { timeout: 10_000 });
    await positionXB.fill('42');
    await positionXB.press('Tab');
    await expect(pageB.locator('.editor-statusbar')).toContainText(saved, { timeout: 10_000 });

    let detail = await (await request.get(`/api/projects/${projectId}`)).json();
    let clip = detail.tracks.flatMap((track) => track.clips)[0];
    expect(clip.transform.scale).toBe(1.25);
    expect(clip.transform.x).toBe(42);

    await scaleA.fill('1.5');
    await scaleA.press('Tab');
    await expect(pageA.locator('.editor-statusbar')).toContainText(saved, { timeout: 10_000 });
    const scaleB = pageB.getByRole('spinbutton', { name: 'Scale' });
    await scaleB.fill('1.75');
    await scaleB.press('Tab');
    await expect(pageB.locator('.editor-statusbar')).toContainText(/Save error|Kaydetme hatas[ıi]/i, { timeout: 10_000 });

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

test('two tabs surface delete-versus-edit conflicts without deleting the saved clip', async ({ browser, request }) => {
  test.setTimeout(60_000);
  const fixtureName = `Delete edit conflict ${Date.now()}`;
  const contextA = await browser.newContext({ baseURL: 'http://127.0.0.1:5173' });
  const contextB = await browser.newContext({ baseURL: 'http://127.0.0.1:5173' });
  const pageA = await contextA.newPage(); const pageB = await contextB.newPage();
  let projectId;
  const saved = /All changes saved|T[uÃ¼]m de[gÄŸ]i[ÅŸs]iklikler kaydedildi/i;
  try {
    await pageA.goto('/'); await pageA.locator('.primary-button.large').click();
    await pageA.locator('.project-name-input').fill(fixtureName);
    await pageA.getByRole('tab', { name: /Stock|Stok/ }).click();
    await pageA.getByRole('button', { name: /White surface|Beyaz y[uÃ¼]zey/ }).click();
    await expect(pageA.locator('.editor-statusbar')).toContainText(saved, { timeout: 10_000 });
    projectId = (await (await request.get('/api/projects')).json()).find((project) => project.name === fixtureName)?.id;
    await pageB.goto('/'); await pageB.locator('article').filter({ hasText: fixtureName }).getByRole('button').first().click();
    await expect(pageB.locator('.timeline-clip')).toHaveCount(1);
    await pageA.locator('.timeline-clip').click();
    const scale = pageA.getByRole('spinbutton', { name: 'Scale' });
    await scale.fill('1.5'); await scale.press('Tab');
    await expect(pageA.locator('.editor-statusbar')).toContainText(saved, { timeout: 10_000 });
    await pageB.locator('.timeline-clip').click({ button: 'right' });
    await pageB.getByRole('menuitem', { name: /^Delete$/i }).click();
    await expect(pageB.locator('.editor-statusbar')).toContainText(/Save error|Kaydetme hatas[Ä±i]/i, { timeout: 10_000 });
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
    await page.getByRole('tab', { name: /Stock|Stok/ }).click();
    await page.getByRole('button', { name: /White surface|Beyaz y[uü]zey/ }).click();
    await expect(page.locator('.editor-statusbar')).toContainText(/All changes saved|T[uü]m de[gğ]i[şs]iklikler kaydedildi/i, { timeout: 10_000 });
    const projects = await (await request.get('/api/projects')).json();
    projectId = projects.find((project) => project.name === fixtureName)?.id;
    expect(projectId).toBeTruthy();
    await expect.poll(async () => (await (await request.get(`/api/projects/${projectId}`)).json()).assets.length, { timeout: 10_000 }).toBe(1);

    await page.getByRole('tab', { name: /Media 1|Medya 1/ }).click();
    await page.clock.install();
    clockInstalled = true;
    page.once('dialog', (dialog) => void dialog.accept());
    await page.locator('.asset-item.pro .asset-dots').click();
    await page.getByRole('menuitem', { name: /Remove from project|Projeden kald[ıi]r/ }).click();
    await expect(page.getByRole('tab', { name: /Media 0|Medya 0/ })).toBeVisible();

    const current = await (await request.get(`/api/projects/${projectId}`)).json();
    const remote = { ...current, assets: current.assets.map((asset) => ({ ...asset, name: `${asset.name} refreshed` })), revision: current.revision };
    expect((await request.patch(`/api/projects/${projectId}`, { data: remote })).ok()).toBeTruthy();
    await page.getByRole('button', { name: /Panel menu|Panel men[uü]s[uü]/ }).click();
    await page.getByRole('menuitem', { name: /Refresh library|K[uü]t[uü]phaneyi yenile/ }).click();
    await expect(page.getByRole('tab', { name: /Media 0|Medya 0/ })).toBeVisible();
    await page.clock.runFor(700);
    await page.clock.resume();
    clockInstalled = false;
    await expect.poll(async () => (await (await request.get(`/api/projects/${projectId}`)).json()).assets.length, { timeout: 10_000 }).toBe(0);

    await page.reload();
    await page.locator('article').filter({ hasText: fixtureName }).getByRole('button').first().click();
    await expect(page.getByRole('tab', { name: /Media 0|Medya 0/ })).toBeVisible();
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
