import { expect, test, type Locator, type Page } from './fixtures/test';

// Smart-task detail edit/clear lane: the collapsed offer row under the hero,
// the inline goal/ready-by editor with the server-previewed landing line, the
// echoed-deadline save, and the two-step Clear that closes the page.
// (The previewed deadline sentinel 1_900_000_000_000 is inlined in the stub —
// `addInitScript` closures cannot capture outer test-scope constants.)

const installSmartTaskApiStub = async (page: Page) => {
  await page.addInitScript(() => {
    (window as typeof window & { __PELS_HOMEY_STUB__?: unknown }).__PELS_HOMEY_STUB__ = {
      apiHandlers: {
        'POST /ui_smart_task_preview': () => ({
          ok: true,
          deadlineAtMs: 1_900_000_000_000,
          deadlineLabel: 'Tomorrow 06:30',
          scheduledWindowLabel: '02:00–04:00',
          estimate: {
            status: 'on_track',
            scheduledHours: [{ startsAtMs: 1, plannedKWh: 1.5 }],
            projectedFinishAtMs: 2,
            energyEstimateKWh: 1.5,
            energyExpectedKWh: 1.4,
            costEstimate: 6.1,
            costUnit: 'kr',
          },
        }),
        'POST /ui_smart_task_update': (body: { deadlineAtMs?: number }) => (
          // Pin the anti-drift echo: the save must carry the previewed
          // deadline; anything else is rejected so the test fails loudly.
          body?.deadlineAtMs === 1_900_000_000_000
            ? { ok: true }
            : { ok: false, reason: 'deadline_passed' }
        ),
        'POST /ui_smart_task_cancel': () => ({ ok: true }),
      },
    };
  });
};

const openDeadlinePlan = async (page: Page): Promise<Locator> => {
  await page.goto('/?page=deadline-plan&deviceId=dev_connected300', { waitUntil: 'domcontentloaded' });
  const panel = page.locator('#deadline-plan-panel');
  await expect(panel.locator('.plan-hero__headline')).toBeVisible();
  return panel;
};

const openEditor = async (page: Page): Promise<Locator> => {
  const panel = await openDeadlinePlan(page);
  const editCard = panel.locator('.smart-task-edit');
  await expect(editCard.getByText('Change the goal or ready-by time.')).toBeVisible();
  await editCard.getByRole('button', { name: 'Edit task' }).click();
  await expect(editCard.locator('.smart-task-edit__time-input')).toBeVisible();
  return panel;
};

test.describe('Smart task edit', () => {
  test.beforeEach(async ({ page }) => {
    await installSmartTaskApiStub(page);
    await page.setViewportSize({ width: 390, height: 900 });
  });

  test('offers the edit row, prefills the editor, and saves the previewed deadline', async ({ page }) => {
    const panel = await openEditor(page);
    const editCard = panel.locator('.smart-task-edit');

    // Prefill: the stub objective's target (65 °C) and its deadline rendered
    // as a local HH:mm.
    const goalInput = editCard.locator('md-filled-text-field input');
    await expect(goalInput).toHaveValue('65');
    const timeValue = await editCard.locator('.smart-task-edit__time-input').inputValue();
    expect(timeValue).toMatch(/^\d{2}:\d{2}$/);
    // Save is disabled while the draft is clean.
    await expect(editCard.getByRole('button', { name: 'Save changes' })).toBeDisabled();

    // Edit both fields → the debounced preview surfaces the server-formatted
    // landing line (the honest "where does this HH:mm land" display) + cost.
    await goalInput.fill('70');
    await editCard.locator('.smart-task-edit__time-input').fill('06:30');
    await expect(editCard.locator('.smart-task-edit__preview-when'))
      .toHaveText('If you save: runs 02:00–04:00 · Ready by Tomorrow 06:30');
    await expect(editCard.locator('.smart-task-edit__preview-cost')).toBeVisible();

    // Save echoes the previewed deadline (the stub rejects anything else),
    // then the editor collapses back to the offer row.
    await editCard.getByRole('button', { name: 'Save changes' }).click();
    await expect(editCard.getByText('Change the goal or ready-by time.')).toBeVisible();
    await expect(editCard.locator('.smart-task-edit__time-input')).toHaveCount(0);
  });

  test('a rejected save keeps the editor open with the reason inline', async ({ page }) => {
    await page.addInitScript(() => {
      (window as typeof window & { __PELS_HOMEY_STUB__?: unknown }).__PELS_HOMEY_STUB__ = {
        apiHandlers: {
          'POST /ui_smart_task_preview': () => ({ ok: false, reason: 'invalid_ready_by' }),
          'POST /ui_smart_task_update': () => ({ ok: false, reason: 'write_conflict' }),
        },
      };
    });
    const panel = await openEditor(page);
    const editCard = panel.locator('.smart-task-edit');
    await editCard.locator('md-filled-text-field input').fill('70');
    await editCard.getByRole('button', { name: 'Save changes' }).click();
    await expect(editCard.locator('.smart-task-edit__error'))
      .toHaveText('Could not save the smart task just now. Try again.');
    await expect(editCard.locator('.smart-task-edit__time-input')).toBeVisible();
  });

  test('clear is two-step and closes the detail page', async ({ page }) => {
    const panel = await openEditor(page);
    const editCard = panel.locator('.smart-task-edit');

    // First tap arms; no cancel call yet (the editor stays open).
    await editCard.getByRole('button', { name: 'Clear task' }).click();
    const confirm = editCard.getByRole('button', { name: 'Tap again to clear' });
    await expect(confirm).toBeVisible();

    // Second tap commits and the page closes back to the Smart tasks tab.
    await confirm.click();
    await expect(panel).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Smart tasks' })).toHaveAttribute('aria-selected', 'true');
  });

  test('a separate-meter task is clear-only and still uses two-step confirmation', async ({ page }) => {
    await page.addInitScript(() => {
      const stubWindow = window as typeof window & {
        __PELS_HOMEY_STUB__?: Record<string, unknown>;
      };
      stubWindow.__PELS_HOMEY_STUB__ = {
        ...(stubWindow.__PELS_HOMEY_STUB__ ?? {}),
        deadlinePlanSeparateMeter: true,
      };
    });
    const panel = await openDeadlinePlan(page);
    const editCard = panel.locator('.smart-task-edit');

    await expect(panel.locator('.plan-hero__headline')).toHaveText('Smart task unavailable');
    await expect(editCard.getByRole('button', { name: 'Edit task' })).toHaveCount(0);
    await expect(editCard.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
    await expect(editCard.locator('.smart-task-edit__time-input')).toHaveCount(0);

    await editCard.getByRole('button', { name: 'Clear task' }).click();
    const confirm = editCard.getByRole('button', { name: 'Tap again to clear' });
    await expect(confirm).toBeVisible();
    await confirm.click();
    await expect(panel).toBeHidden();
  });

  test('discard closes the editor without saving', async ({ page }) => {
    const panel = await openEditor(page);
    const editCard = panel.locator('.smart-task-edit');
    await editCard.locator('md-filled-text-field input').fill('70');
    await editCard.getByRole('button', { name: 'Discard' }).click();
    await expect(editCard.locator('.smart-task-edit__time-input')).toHaveCount(0);
    await expect(editCard.getByText('Change the goal or ready-by time.')).toBeVisible();
  });
});
