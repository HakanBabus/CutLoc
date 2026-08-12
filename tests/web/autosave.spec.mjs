import { test, expect } from '@playwright/test';

test('immediate Back keeps the latest project edit', async ({ page, request }) => {
  const fixtureName = `Browser autosave ${Date.now()}`;
  await page.goto('/');
  await expect(page.locator('.primary-button.large')).toBeVisible();

  try {
    await page.locator('.primary-button.large').click();
    await expect(page.locator('.project-name-input')).toBeVisible();
    await page.locator('.project-name-input').fill(fixtureName);
    await page.getByRole('tab', { name: /Stock|Stok/ }).click();
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
  const fixtureName = 'Server refresh dirty ' + Date.now();
  let projectId;
  let clockInstalled = false;
  await page.goto('/');
  await expect(page.locator('.primary-button.large')).toBeVisible();
  try {
    await page.locator('.primary-button.large').click();
    await expect(page.locator('.project-name-input')).toBeVisible();
    await page.locator('.project-name-input').fill(fixtureName);
    await page.getByRole('tab', { name: /Stock|Stok/ }).click();
    await page.getByRole('button', { name: /White surface|Beyaz y[uü]zey/ }).click();
    await expect(page.locator('.timeline-clip')).toHaveCount(1);
    await expect(page.locator('.editor-statusbar')).toContainText(/All changes saved|T[uü]m de[gğ]i[şs]iklikler kaydedildi/i, { timeout: 10_000 });
    await expect.poll(async () => {
      const response = await request.get('/api/projects');
      if (!response.ok()) return null;
      const projects = await response.json();
      return projects.find((project) => project.name === fixtureName)?.id ?? null;
    }, { timeout: 10_000 }).not.toBeNull();
    const projectsResponse = await request.get('/api/projects');
    projectId = (await projectsResponse.json()).find((project) => project.name === fixtureName).id;
    await page.clock.install();
    clockInstalled = true;
    const scale = page.getByRole('spinbutton', { name: 'Scale' });
    await scale.fill('1.25');
    await scale.press('Tab');
    await expect(scale).toHaveValue('1.25');
    const currentResponse = await request.get('/api/projects/' + projectId);
    const current = await currentResponse.json();
    const refreshedAssets = current.assets.map((asset, index) => index === 0 ? { ...asset, name: asset.name + ' metadata' } : asset);
    const metadataResponse = await request.patch('/api/projects/' + projectId, { data: { ...current, assets: refreshedAssets, revision: current.revision } });
    expect(metadataResponse.ok()).toBeTruthy();
    await page.getByRole('button', { name: 'Panel menu' }).click();
    await page.getByRole('menuitem', { name: /Refresh library|K[uü]t[uü]phaneyi yenile/ }).click();
    await expect(page.locator('.editor-statusbar')).toContainText(/Saving|Kaydediliyor/i, { timeout: 5_000 });
    await page.clock.runFor(600);
    await expect(page.locator('.editor-statusbar')).toContainText(/All changes saved|T[uü]m de[gğ]i[şs]iklikler kaydedildi/i, { timeout: 10_000 });
    await page.clock.resume();
    clockInstalled = false;
    await page.locator('.back-button').click();
    await expect(page.getByRole('heading', { name: fixtureName })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: fixtureName })).toBeVisible();
    await page.locator('article').filter({ hasText: fixtureName }).getByRole('button').first().click();
    await expect(page.locator('.timeline-clip')).toHaveCount(1);
    await page.locator('.timeline-clip').click();
    await expect(page.getByRole('spinbutton', { name: 'Scale' })).toHaveValue('1.25');
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
