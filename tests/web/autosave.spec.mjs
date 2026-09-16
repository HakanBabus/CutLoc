import { test, expect } from '@playwright/test';

test('immediate Back keeps the latest project edit', async ({ page, request }) => {
  const fixtureName = `Browser autosave ${Date.now()}`;
  await page.goto('/');
  await expect(page.locator('.primary-button.large')).toBeVisible();

  try {
    await page.locator('.primary-button.large').click();
    await expect(page.locator('.project-name-input')).toBeVisible();
    await page.locator('.project-name-input').fill(fixtureName);
    await page.locator('.tool-rail button').filter({ hasText: /Elements|Öğeler/ }).click();
    await page.getByRole('button', { name: /White surface|Beyaz yüzey/ }).click();
    await expect(page.locator('.timeline-clip')).toHaveCount(1);
    await page.locator('.back-button').click();

    await expect(page.getByRole('heading', { name: fixtureName })).toBeVisible();
    const projectsResponse = await request.get('/api/projects');
    expect(projectsResponse.ok()).toBeTruthy();
    const projects = await projectsResponse.json();
    const fixture = projects.find((project) => project.name === fixtureName);
    expect(fixture).toBeTruthy();
    const detailResponse = await request.get(`/api/projects/${fixture.id}`);
    expect(detailResponse.ok()).toBeTruthy();
    const detail = await detailResponse.json();
    const clips = detail.tracks.flatMap((track) => track.clips);
    expect(clips.some((clip) => clip.type === 'image' && clip.assetId === detail.assets[0].id)).toBeTruthy();
  } finally {
    const projectsResponse = await request.get('/api/projects');
    if (projectsResponse.ok()) {
      const projects = await projectsResponse.json();
      const fixture = projects.find((project) => project.name === fixtureName);
      if (fixture) {
        const deletedResponse = await request.delete(`/api/projects/${fixture.id}`);
        if (deletedResponse.ok()) {
          const deleted = await deletedResponse.json();
          if (deleted.trashId) await request.delete(`/api/trash/${deleted.trashId}`);
        }
      }
    }
  }
});

test('server metadata refresh keeps a dirty local timeline edit until autosave', async ({ page, request }) => {
  test.setTimeout(90_000);
  const fixtureName = 'Server refresh dirty ' + Date.now();
  let projectId;
  let clockInstalled = false;
  await page.goto('/');
  await expect(page.locator('.primary-button.large')).toBeVisible();
  try {
    await page.locator('.primary-button.large').click();
    await expect(page.locator('.project-name-input')).toBeVisible();
    await page.locator('.project-name-input').fill(fixtureName);
    await page.locator('.tool-rail button').filter({ hasText: /Elements|Öğeler/ }).click();
    await page.getByRole('button', { name: /White surface|Beyaz y[uü]zey/ }).click();
    await expect(page.locator('.timeline-clip')).toHaveCount(1);
    // A cold Windows runner can spend more than ten seconds starting the
    // derived-media toolchain. Wait for the real persisted precondition first,
    // then require the UI to leave its saving state before freezing the clock.
    await expect.poll(async () => {
      const response = await request.get('/api/projects');
      if (!response.ok()) return null;
      const projects = await response.json();
      const fixture = projects.find((project) => project.name === fixtureName);
      if (!fixture) return null;
      const detailResponse = await request.get(`/api/projects/${fixture.id}`);
      if (!detailResponse.ok()) return null;
      const detail = await detailResponse.json();
      return detail.tracks.flatMap((track) => track.clips).some((clip) => clip.type === 'image') ? fixture.id : null;
    }, { timeout: 30_000 }).not.toBeNull();
    await expect(page.locator('.save-indicator')).toContainText(/Saved|Kaydedildi/i, { timeout: 30_000 });
    const projectsResponse = await request.get('/api/projects');
    projectId = (await projectsResponse.json()).find((project) => project.name === fixtureName).id;
    await page.locator('.tool-rail button').filter({ hasText: /Media|Medya/ }).click();
    const panelMenuButton = await page.getByRole('button', { name: /Panel menu|Panel menüsü/ }).elementHandle();
    expect(panelMenuButton).toBeTruthy();
    await page.clock.install();
    clockInstalled = true;
    const scale = page.getByRole('spinbutton', { name: /Scale|Ölçek/ });
    await scale.fill('1.25');
    await scale.press('Tab');
    await expect(scale).toHaveValue('1.25');
    const currentResponse = await request.get('/api/projects/' + projectId);
    const current = await currentResponse.json();
    const refreshedAssets = current.assets.map((asset, index) => index === 0 ? { ...asset, name: asset.name + ' metadata' } : asset);
    const metadataResponse = await request.patch('/api/projects/' + projectId, { data: { ...current, assets: refreshedAssets, revision: current.revision } });
    expect(metadataResponse.ok()).toBeTruthy();
    await panelMenuButton.evaluate((button) => button.click());
    await page.evaluate(() => {
      const refreshItem = [...document.querySelectorAll('[role="menuitem"]')].find((item) => /Refresh library|Kütüphaneyi yenile/i.test(item.textContent ?? ''));
      if (!(refreshItem instanceof HTMLElement)) throw new Error('Refresh library menu item did not open');
      refreshItem.click();
    });
    await expect(page.locator('.save-indicator')).toContainText(/Saving|Kaydediliyor/i, { timeout: 5_000 });
    await page.clock.runFor(600);
    await expect(page.locator('.save-indicator')).toContainText(/Saved|Kaydedildi/i, { timeout: 10_000 });
    await page.clock.resume();
    clockInstalled = false;
    await page.locator('.back-button').click();
    await expect(page.getByRole('heading', { name: fixtureName })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: fixtureName })).toBeVisible();
    await page.locator('article').filter({ hasText: fixtureName }).getByRole('button').first().click();
    await expect(page.locator('.timeline-clip')).toHaveCount(1);
    await page.locator('.timeline-clip').click();
    await expect(page.getByRole('spinbutton', { name: /Scale|Ölçek/ })).toHaveValue('1.25');
  } finally {
    if (clockInstalled) await page.clock.resume().catch(() => undefined);
    if (projectId) {
      const deletedResponse = await request.delete('/api/projects/' + projectId);
      if (deletedResponse.ok()) {
        const deleted = await deletedResponse.json();
        if (deleted.trashId) await request.delete('/api/trash/' + deleted.trashId);
      }
    }
  }
});
