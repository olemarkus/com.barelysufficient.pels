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
  await expect(editCard.getByText('Change the goal, ready-by time, or extra permissions.')).toBeVisible();
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
    await expect(editCard.getByText('Change the goal, ready-by time, or extra permissions.')).toBeVisible();
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

  // Issue #2: the Extra permissions were only settable from a Flow card, so a
  // user who had granted one had no way to take it back. The editor now sets
  // all three, and the request it sends is what makes a revoke actionable
  // server-side — it must name every permission, not only the ones switched on.
  test('sets the extra permissions and sends all three on save', async ({ page }) => {
    await page.addInitScript(() => {
      const stubWindow = window as typeof window & {
        __PELS_HOMEY_STUB__?: Record<string, unknown>;
        __LAST_SMART_TASK_UPDATE__?: unknown;
      };
      stubWindow.__PELS_HOMEY_STUB__ = {
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
          'POST /ui_smart_task_update': (body: unknown) => {
            stubWindow.__LAST_SMART_TASK_UPDATE__ = body;
            return { ok: true };
          },
        },
      };
    });
    const panel = await openEditor(page);
    const editCard = panel.locator('.smart-task-edit');
    const permissions = editCard.locator('.smart-task-edit__permissions');

    // Collapsed by default on a task holding no permission; the summary opens it.
    await expect(permissions).not.toHaveAttribute('open', '');
    await permissions.locator('summary').click();

    const rows = permissions.locator('.md-switch-row');
    await expect(rows).toHaveCount(3);
    // Limit-lower-priority is inert without the budget exemption, so it starts
    // disabled and only becomes settable once the exemption is on.
    const limitSwitch = rows.nth(1).locator('md-switch');
    await expect(limitSwitch).toHaveAttribute('disabled', '');
    await rows.nth(0).locator('md-switch').click();
    await expect(limitSwitch).not.toHaveAttribute('disabled', '');
    await limitSwitch.click();

    // A permission-only change arms Save on its own — no goal/ready-by edit.
    const save = editCard.getByRole('button', { name: 'Save changes' });
    await expect(save).toBeEnabled();
    await save.click();
    await expect(editCard.locator('.smart-task-edit__time-input')).toHaveCount(0);

    const body = await page.evaluate(() => (
      (window as typeof window & { __LAST_SMART_TASK_UPDATE__?: Record<string, unknown> })
        .__LAST_SMART_TASK_UPDATE__
    ));
    expect(body).toMatchObject({
      exemptFromBudget: true,
      limitLowerPriorityDevices: true,
      // Sent explicitly even though it is off, so an unchecked toggle can
      // actually revoke instead of reading as "unchanged".
      pauseLowerPriorityDevices: false,
    });
  });

  test('a permission-only save does not claim the run moved to Past tasks', async ({ page }) => {
    // Goal and ready-by are untouched, so the objective the recorder compares is
    // unchanged and the current run keeps going — the generic "the earlier run
    // is now in Past tasks" toast would send the user hunting for a history
    // entry that was never written.
    const panel = await openEditor(page);
    const editCard = panel.locator('.smart-task-edit');
    await editCard.locator('.smart-task-edit__permissions summary').click();
    await editCard.locator('.md-switch-row').nth(0).locator('md-switch').click();
    // Let the debounced re-preview land so the save echoes the previewed
    // deadline the stub demands (the anti-drift echo, pinned by the first test).
    await expect(editCard.locator('.smart-task-edit__preview-when')).toBeVisible();
    await editCard.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('#toast')).toHaveText('Smart task updated — the new permissions apply to this run.');
  });

  test('hides the read-only permissions row while the editor owns the same setting', async ({ page }) => {
    // Two blocks under one "Extra permissions" label — the saved value and the
    // unsaved draft — disagree the moment a toggle moves, with nothing saying
    // which is which. The read-only row yields to the editor and comes back on
    // close.
    await page.addInitScript(() => {
      const stubWindow = window as typeof window & { __PELS_HOMEY_STUB__?: Record<string, unknown> };
      stubWindow.__PELS_HOMEY_STUB__ = {
        ...(stubWindow.__PELS_HOMEY_STUB__ ?? {}),
        settings: {
          deferred_objectives: {
            version: 1,
            objectivesByDeviceId: {
              dev_connected300: {
                enabled: true,
                kind: 'temperature',
                enforcement: 'soft',
                targetTemperatureC: 65,
                deadlineAtMs: Date.now() + 8 * 60 * 60 * 1000,
                rescue: { exemptFromBudget: 'always' },
              },
            },
          },
        },
      };
    });
    const panel = await openDeadlinePlan(page);
    const readOnlyRow = panel.locator('.plan-inputs__row', { hasText: 'Extra permissions' });
    await expect(readOnlyRow).toBeVisible();

    const editCard = panel.locator('.smart-task-edit');
    await editCard.getByRole('button', { name: 'Edit task' }).click();
    await expect(editCard.locator('.smart-task-edit__time-input')).toBeVisible();
    await expect(readOnlyRow).toHaveCount(0);
    // The task already holds a grant, so the disclosure opens itself rather than
    // hiding a permission the user can now revoke behind a closed panel.
    const disclosure = editCard.locator('.smart-task-edit__permissions');
    await expect(disclosure).toHaveAttribute('open', '');
    // Open, the rows themselves say what is granted, so the summary line would
    // restate their labels verbatim underneath them — it belongs to the closed
    // state, where it is the only thing that answers "what does this task have?".
    const grantedLine = editCard.locator('.smart-task-edit__permissions-granted');
    await expect(grantedLine).toBeHidden();
    await disclosure.locator('summary').click();
    await expect(grantedLine).toBeVisible();
    await expect(grantedLine).toHaveText('May go over daily budget');

    await editCard.getByRole('button', { name: 'Discard' }).click();
    await expect(readOnlyRow).toBeVisible();
  });

  test('discard closes the editor without saving', async ({ page }) => {
    const panel = await openEditor(page);
    const editCard = panel.locator('.smart-task-edit');
    await editCard.locator('md-filled-text-field input').fill('70');
    await editCard.getByRole('button', { name: 'Discard' }).click();
    await expect(editCard.locator('.smart-task-edit__time-input')).toHaveCount(0);
    await expect(editCard.getByText('Change the goal, ready-by time, or extra permissions.')).toBeVisible();
  });
});
