import { test, expect } from '@playwright/test';

const themes = [
  { name: 'light', label: /Light|Beyaz/i },
  { name: 'gray', label: /Gray|Gri/i },
  { name: 'dark', label: /Dark|Koyu/i },
];

test('theme palettes and animation controls stay coherent across the workspace', async ({ page, request }) => {
  test.setTimeout(45_000);
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
    await page.locator('.tool-rail button').filter({ hasText: /Media|Medya/ }).click();
    await page.getByRole('tab', { name: /Stock|Stok/ }).click();
    await page.getByRole('button', { name: /White surface|Beyaz yüzey/ }).click();
    await expect(page.locator('.timeline-clip')).toHaveCount(1);
    await page.locator('.timeline-clip').click();
    await page.locator('.tool-rail button').filter({ hasText: /Animation|Animasyon/ }).click();
    await expect(page.locator('.animation-card')).toHaveCount(9);

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
          cardRadius: cardStyle?.borderRadius ?? '',
          sliderAppearance: sliderStyle?.appearance ?? '',
          sliderHeight: sliderStyle?.height ?? '',
        };
      });
      expect(controls.cardBackground).toContain('gradient');
      expect(controls.cardRadius).toBe('10px');
      expect(controls.sliderAppearance).toBe('none');
      expect(controls.sliderHeight).toBe('18px');
    }

    const durationSlider = page.locator('.animation-studio input[type="range"]').first();
    await expect(durationSlider).toBeEnabled();
    const before = await durationSlider.inputValue();
    await durationSlider.focus();
    await page.keyboard.press('ArrowRight');
    expect(await durationSlider.inputValue()).not.toBe(before);
  } finally {
    const deletedResponse = await request.delete(`/api/projects/${projectId}`);
    if (deletedResponse.ok()) {
      const deleted = await deletedResponse.json();
      if (deleted.trashId) await request.delete(`/api/trash/${deleted.trashId}`);
    }
  }
});
