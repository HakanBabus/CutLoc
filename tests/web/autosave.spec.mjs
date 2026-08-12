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
