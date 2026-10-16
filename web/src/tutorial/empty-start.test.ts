import { describe, expect, it } from 'vitest';
import { chapterStart, stepStart } from './chapters';
import { validateShape, type CourseData } from './course-schema';
import { COURSE } from './chapters';
import { validatePatch } from '../patch';
import { DEFS } from '../modules';
import { Engine } from '../engine';

describe('empty canvas start', () => {
  const course: CourseData = structuredClone(COURSE) as CourseData;
  course.chapters[0].start = { kind: 'empty' };
  it('passes the shape check', () => { expect(() => validateShape(JSON.parse(JSON.stringify(course)))).not.toThrow(); });
  it('has no modules and loads', () => {
    const p = chapterStart(0, course);
    expect(p.modules).toEqual([]);
    expect(p.name).toBe(course.chapters[0].patchName);
    validatePatch(p, DEFS);
    new Engine(48000).load(p);
  });
  it('is the first step\'s start', () => { course.chapters[0].steps = []; expect(stepStart(0, 0, course).modules).toEqual([]); });
});
