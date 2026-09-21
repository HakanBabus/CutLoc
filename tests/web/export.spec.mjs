import { test, expect } from '@playwright/test';

test('export polling watchdog catches completion when SSE emits no job event', async ({ page, request }) => {
  test.setTimeout(30_000);
  const fixtureName = `Export watchdog ${Date.now()}`;
  let projectId;

  try {
    await page.goto('/');
    await page.locator('.primary-button.large').click();
    await page.locator('.project-name-input').fill(fixtureName);
    await page.locator('.tool-rail button').filter({ hasText: /Elements|Öğeler/ }).click();
    await page.getByRole('button', { name: /White surface|Beyaz yüzey/ }).click();
    await expect(page.locator('.save-indicator')).toContainText(/Saved|Kaydedildi/i, { timeout: 10_000 });

    const projects = await (await request.get('/api/projects')).json();
    projectId = projects.find((project) => project.name === fixtureName)?.id;
    expect(projectId).toBeTruthy();

    await page.evaluate(() => {
      class SilentEventSource {
        constructor(url) { this.url = url; this.readyState = 1; this.onerror = null; }
        addEventListener() {}
        close() { this.readyState = 2; }
      }
      Object.defineProperty(window, 'EventSource', { configurable: true, writable: true, value: SilentEventSource });
    });

    let jobReads = 0;
    const now = new Date().toISOString();
    await page.route('**/api/projects/*/export**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith('/preflight')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, errors: [], warnings: [], estimatedBytes: 1024 }) });
      }
      return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ preflight: { ok: true, errors: [], warnings: [] }, job: { id: 'job_watchdog' } }) });
    });
    await page.route('**/api/jobs/job_watchdog', async (route) => {
      jobReads += 1;
      const completed = jobReads >= 2;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'job_watchdog', projectId, kind: 'export', status: completed ? 'completed' : 'running',
          progress: completed ? 1 : 0.4, message: completed ? 'Export completed' : 'Exporting video',
          fileName: 'watchdog.mp4', format: 'mp4', downloadUrl: '/api/jobs/job_watchdog/download', createdAt: now, updatedAt: now,
        }),
      });
    });

    await page.locator('.export-button').click();
    const exportModal = page.locator('.export-modal');
    await expect(exportModal).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(exportModal.locator(':focus')).toHaveCount(1);
    await exportModal.locator('select').first().selectOption('mp3');
    await expect(exportModal.getByText(/Resolution|Çözünürlük/, { exact: true })).toHaveCount(0);
    await expect(exportModal.getByText(/Frame rate|Kare hızı/, { exact: true })).toHaveCount(0);
    await expect(exportModal.locator('.quality-tabs')).toHaveCount(0);
    await exportModal.locator('select').first().selectOption('wav');
    await expect(exportModal.locator('.export-format-note').getByText(/PCM/)).toBeVisible();
    await exportModal.locator('select').first().selectOption('mp4');
    await page.locator('.export-start-button').click();
    const success = page.locator('.export-success-view');
    await expect(success).toBeVisible({ timeout: 6_000 });
    await expect(success).toContainText(/Export complete|Dışa aktarma tamamlandı/);
    await expect(success.getByRole('link', { name: /Download file|Dosyayı indir/ })).toHaveAttribute('href', '/api/jobs/job_watchdog/download');
    expect(jobReads).toBeGreaterThanOrEqual(2);
    await success.getByRole('button', { name: /Change settings|Ayarları değiştir/ }).click();
    await expect(page.locator('.export-start-button')).toBeEnabled();
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
