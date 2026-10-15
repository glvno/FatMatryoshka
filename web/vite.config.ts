import { defineConfig } from 'vite';
import { lessonEditor } from './dev/lesson-editor.ts';

export default defineConfig({
  base: './',
  plugins: [lessonEditor()],
  // the tutorial's built-in riff is a MIDI file, imported as bytes (`?inline`)
  assetsInclude: ['**/*.mid'],
  build: { target: 'es2022' },
  test: { environment: 'node' },
} as never);
