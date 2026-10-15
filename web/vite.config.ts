import { defineConfig } from 'vite';
import { lessonEditor } from './dev/lesson-editor.ts';

export default defineConfig({
  base: './',
  plugins: [lessonEditor()],
  build: { target: 'es2022' },
  test: { environment: 'node' },
} as never);
