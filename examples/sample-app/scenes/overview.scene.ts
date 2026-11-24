import { scene } from '../../../src/scene.ts';

scene(
  'overview',
  {
    title: 'Adding a task with zoom and narration',
    blurb: 'Demonstrates cursor tweening, typing, CSS zoom-in, 2x screenshot, and offline voice.',
  },
  async ({ actor, page, shot }) => {
    await actor.click(page.getByTestId('task-input'));
    await actor.type('Record offline voiceover');
    await actor.click(page.getByTestId('add-btn'));
    await actor.settle();

    await actor.spotlight(
      page.getByTestId('task-row-0'),
      'Your new task appears right at the top of the list.',
      { scale: 1.7, stay: true }
    );
    await shot('added');
    await actor.unfocus();
  }
);
