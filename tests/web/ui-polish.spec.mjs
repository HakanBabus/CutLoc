import { test, expect } from '@playwright/test';
import { sourceTimeAt } from '@cutloc/shared';

const themes = [
  { name: 'light', label: /Light|Beyaz/i },
  { name: 'gray', label: /Gray|Gri/i },
  { name: 'dark', label: /Dark|Koyu/i },
];

test('new text clips start without fades or transitions', async ({ page, request }) => {
  const fixtureName = `Text defaults ${Date.now()}`;
  const createdResponse = await request.post('/api/projects', { data: { name: fixtureName } });
  expect(createdResponse.ok()).toBeTruthy();
  const created = await createdResponse.json();
  const projectId = created.id;

  try {
    await page.goto('/');
    const fixtureCard = page.locator('article.project-card').filter({ hasText: fixtureName });
    await expect(fixtureCard).toBeVisible();
    await fixtureCard.getByRole('button').first().click();
    await expect(page.locator('.editor-shell')).toBeVisible();

    await page.locator('.tool-rail button').filter({ hasText: /Text|Metin/ }).click();
    await page.locator('.text-primary-action').click();
    await expect(page.locator('.timeline-clip')).toHaveCount(1);

    await expect.poll(async () => {
      const response = await request.get(`/api/projects/${projectId}`);
      const project = await response.json();
      return project.tracks.flatMap((track) => track.clips).find((clip) => clip.type === 'text');
    }).toMatchObject({
      fadeIn: 0,
      fadeOut: 0,
      transitionIn: { type: 'none', duration: 0 },
      transitionOut: { type: 'none', duration: 0 },
    });
  } finally {
    const deletedResponse = await request.delete(`/api/projects/${projectId}`);
    if (deletedResponse.ok()) {
      const deleted = await deletedResponse.json();
      if (deleted.trashId) await request.delete(`/api/trash/${deleted.trashId}`);
    }
  }
});

test('theme palettes and animation controls stay coherent across the workspace', async ({ page, request }) => {
  test.setTimeout(75_000);
  const fixtureName = `UI polish ${Date.now()}`;
  const createdResponse = await request.post('/api/projects', { data: { name: fixtureName } });
  expect(createdResponse.ok()).toBeTruthy();
  const created = await createdResponse.json();
  const projectId = created.id;

  try {
    await page.goto('/');
    await expect(page.locator('.dashboard')).toBeVisible();
    const fixtureCard = page.locator('article.project-card').filter({ hasText: fixtureName });
    await expect(fixtureCard).toBeVisible();
    const themeButtons = page.locator('.theme-switcher:not(.compact) button');
    await expect(themeButtons).toHaveCount(3);

    for (const [index, theme] of themes.entries()) {
      await themeButtons.nth(index).click();
      await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', theme.name);
      const palette = await page.locator('.app-shell').evaluate((shell) => {
        const shellStyle = getComputedStyle(shell);
        const header = shell.querySelector('.dashboard-header');
        const card = shell.querySelector('.project-card');
        return {
          scheme: shellStyle.colorScheme,
          background: shellStyle.getPropertyValue('--theme-bg').trim(),
          text: shellStyle.getPropertyValue('--theme-text').trim(),
          headerBackground: header ? getComputedStyle(header).backgroundColor : '',
          cardRadius: card ? getComputedStyle(card).borderRadius : '',
          cardShadow: card ? getComputedStyle(card).boxShadow : '',
        };
      });
      expect(palette.background).not.toBe('');
      expect(palette.text).not.toBe('');
      expect(palette.headerBackground).not.toBe('rgba(0, 0, 0, 0)');
      expect(palette.cardRadius).toBe('15px');
      expect(palette.cardShadow).not.toBe('none');
      expect(palette.scheme).toBe(theme.name === 'light' ? 'light' : 'dark');
    }

    await fixtureCard.getByRole('button').first().click();
    await expect(page.locator('.editor-shell')).toBeVisible();
    await expect(page.locator('.timeline-empty-guide')).toContainText(/first clip|İlk klibini/i);
    await page.locator('.tool-rail button').filter({ hasText: /Elements|Öğeler/ }).click();
    await page.getByRole('button', { name: /White surface|Beyaz yüzey/ }).click();
    await expect(page.locator('.timeline-clip')).toHaveCount(1);
    const timelineClip = page.locator('.timeline-clip');
    await expect(timelineClip).toHaveAttribute('role', 'button');
    await page.locator('.timeline-tool').first().click();
    await expect(timelineClip).toHaveAttribute('aria-pressed', 'false');
    await timelineClip.focus();
    await page.keyboard.press('Enter');
    await expect(timelineClip).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.inspector-tool-tabs').getByRole('tab', { name: /Speed|Hız/ }).click();
    await expect(page.locator('.speed-metrics')).toContainText(/Source|Kaynak/);
    await page.locator('.speed-mode-grid button').filter({ hasText: /Speed up|Hızlan/ }).click();
    await expect.poll(async () => {
      const response = await request.get(`/api/projects/${projectId}`);
      const saved = await response.json();
      const clip = saved.tracks.flatMap((track) => track.clips).find((item) => item.type === 'image');
      if (!clip?.speedCurve?.length) return Number.POSITIVE_INFINITY;
      return Math.abs(sourceTimeAt(clip.speedCurve, clip.speed, clip.duration) - clip.sourceDuration);
    }).toBeLessThan(0.001);
    await page.locator('.inspector-tool-tabs').getByRole('tab', { name: /Animation|Animasyon/ }).click();
    await expect(page.locator('.animation-card')).toHaveCount(9);
    const animationStudio = page.locator('.animation-studio-v3');
    await expect(animationStudio).toHaveAttribute('data-category', 'all');
    const animationLayout = await animationStudio.locator('.animation-preset-list').evaluate((list) => ({
      columns: getComputedStyle(list).gridTemplateColumns.split(' ').filter(Boolean).length,
      cardColumns: getComputedStyle(list.querySelector('.animation-card')).gridTemplateColumns,
    }));
    expect(animationLayout.columns).toBe(2);
    expect(animationLayout.cardColumns.split(' ').length).toBe(2);

    await page.getByRole('tab', { name: /^(Motion|Hareket)$/i }).click();
    await expect(page.locator('.animation-card')).toHaveCount(5);
    await page.getByRole('tab', { name: /^(All|Tümü)$/i }).click();
    await expect(page.locator('.animation-card')).toHaveCount(9);
    await page.locator('.animation-card').filter({ hasText: /Fade|Soluklaş/ }).click();
    const editorNotice = page.locator('.editor-notice');
    await expect(editorNotice).toBeVisible();
    const noticeTypography = await editorNotice.evaluate((element) => ({ fontSize: parseFloat(getComputedStyle(element).fontSize), lineHeight: getComputedStyle(element).lineHeight }));
    expect(noticeTypography.fontSize).toBeGreaterThanOrEqual(12);
    expect(noticeTypography.lineHeight).not.toBe('normal');
    await expect(editorNotice).toBeHidden({ timeout: 7_000 });
    await page.getByRole('tab', { name: /^(Combo|Karma)$/i }).click();
    await expect(page.locator('.animation-studio input[type="range"]')).toHaveCount(2);
    await expect(page.locator('.animation-duration-card input[type="number"]')).toHaveCount(2);
    await expect(page.locator('.animation-duration-presets button')).toHaveCount(8);
    const durationUi = await page.locator('.animation-duration-grid').evaluate((grid) => ({
      language: document.documentElement.lang,
      cards: [...grid.querySelectorAll('.animation-duration-card')].map((card) => ({
        kind: card.getAttribute('data-duration-kind'),
        label: card.querySelector('strong')?.textContent?.trim(),
        ariaLabel: card.querySelector('input[type="number"]')?.getAttribute('aria-label'),
        inputHeight: card.querySelector('input[type="number"]') instanceof HTMLElement ? card.querySelector('input[type="number"]').getBoundingClientRect().height : 0,
        firstPreset: card.querySelector('.animation-duration-presets button')?.textContent?.trim(),
        presetHeight: card.querySelector('.animation-duration-presets button') instanceof HTMLElement ? card.querySelector('.animation-duration-presets button').getBoundingClientRect().height : 0,
      })),
    }));
    expect(durationUi.cards.map((card) => card.kind)).toEqual(['in', 'out']);
    expect(durationUi.cards[0].label).toMatch(/Entrance|Giriş/i);
    expect(durationUi.cards[1].label).toMatch(/Exit|Çıkış/i);
    expect(durationUi.cards[0].ariaLabel).not.toBe(durationUi.cards[1].ariaLabel);
    expect(durationUi.cards.every((card) => card.inputHeight >= 36 && card.presetHeight >= 36)).toBeTruthy();
    expect(durationUi.cards[0].firstPreset).toBe(durationUi.language === 'tr' ? '0,20s' : '0.20s');
    const advancedButton = page.getByRole('button', { name: /Advanced motion|Gelişmiş hareket/ });
    await expect(advancedButton).toHaveAttribute('aria-controls', 'animation-advanced-controls');
    await advancedButton.click();
    await expect(page.locator('#animation-advanced-controls')).toBeVisible();

    const compactButtons = page.locator('.theme-switcher.compact button');
    for (const [index, theme] of themes.entries()) {
      await compactButtons.nth(index).click();
      await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', theme.name);
      const controls = await page.locator('.app-shell').evaluate((shell) => {
        const animationCard = shell.querySelector('.animation-card');
        const slider = shell.querySelector('.animation-studio input[type="range"]');
        const cardStyle = animationCard ? getComputedStyle(animationCard) : null;
        const sliderStyle = slider ? getComputedStyle(slider) : null;
        return {
          cardBackground: cardStyle?.backgroundImage ?? '',
          cardBackgroundColor: cardStyle?.backgroundColor ?? '',
          cardRadius: cardStyle?.borderRadius ?? '',
          sliderAppearance: sliderStyle?.appearance ?? '',
          sliderHeight: sliderStyle?.height ?? '',
        };
      });
      expect(controls.cardBackgroundColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(controls.cardRadius).toBe('9px');
      expect(controls.sliderAppearance).toBe('none');
      expect(controls.sliderHeight).toBe('18px');
    }

    const durationSlider = page.locator('.animation-studio input[type="range"]').first();
    await expect(durationSlider).toBeEnabled();
    const before = await durationSlider.inputValue();
    await durationSlider.focus();
    await page.keyboard.press('ArrowRight');
    expect(await durationSlider.inputValue()).not.toBe(before);

    await page.locator('.tool-rail button').filter({ hasText: /Project|Proje/ }).click();
    await expect(page.locator('.project-tool-list')).not.toContainText(/Timeline guide|Timeline rehberi/i);
    await expect(page.locator('.project-tool-list')).toContainText(/project bundle|proje paketi/i);
    await page.locator('.editor-settings').click();
    const settingsModal = page.locator('.settings-modal-v2');
    await expect(settingsModal).toBeVisible();
    await expect(settingsModal.locator('.settings-section')).toHaveCount(3);
    await expect(settingsModal.locator('.settings-actions')).toBeVisible();
    await settingsModal.locator('.settings-tabs button').filter({ hasText: /Shortcuts|Kısayollar/ }).click();
    await expect(settingsModal.locator('.shortcut-setting-row')).toHaveCount(10);
    const settingsContent = settingsModal.locator('.settings-content');
    const pageScrollBefore = await page.evaluate(() => window.scrollY);
    await settingsContent.hover();
    await page.mouse.wheel(0, 600);
    await expect.poll(() => settingsContent.evaluate((content) => content.scrollTop)).toBeGreaterThan(0);
    const settingsFrame = await settingsModal.evaluate((modal) => {
      const footer = modal.querySelector('.settings-actions');
      const header = modal.querySelector('.settings-modal-head');
      const modalRect = modal.getBoundingClientRect();
      const footerRect = footer?.getBoundingClientRect();
      const headerRect = header?.getBoundingClientRect();
      return {
        footerInside: Boolean(footerRect && footerRect.top >= modalRect.top && footerRect.bottom <= modalRect.bottom + 1),
        headerInside: Boolean(headerRect && headerRect.top >= modalRect.top - 1 && headerRect.bottom <= modalRect.bottom),
      };
    });
    expect(settingsFrame.footerInside).toBeTruthy();
    expect(settingsFrame.headerInside).toBeTruthy();
    expect(await page.evaluate(() => window.scrollY)).toBe(pageScrollBefore);
    await settingsModal.getByRole('button', { name: /Close|Kapat/i }).click();
  } finally {
    const deletedResponse = await request.delete(`/api/projects/${projectId}`);
    if (deletedResponse.ok()) {
      const deleted = await deletedResponse.json();
      if (deleted.trashId) await request.delete(`/api/trash/${deleted.trashId}`);
    }
  }
});
