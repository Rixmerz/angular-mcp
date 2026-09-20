import { describe, expect, it } from 'vitest';

import { matchAnyGlob, matchGlob } from '../../src/rules/glob.js';

describe('matchGlob', () => {
  it('matches a literal path exactly', () => {
    expect(matchGlob('src/app/app.component.ts', 'src/app/app.component.ts')).toBe(true);
    expect(matchGlob('src/app/app.component.ts', 'src/app/other.component.ts')).toBe(false);
  });

  it('matches "*" within a single path segment only', () => {
    expect(matchGlob('src/app/*.component.ts', 'src/app/user.component.ts')).toBe(true);
    expect(matchGlob('src/app/*.component.ts', 'src/app/nested/user.component.ts')).toBe(false);
  });

  it('matches "**/" as zero or more path segments', () => {
    expect(matchGlob('src/app/**/*.component.ts', 'src/app/user.component.ts')).toBe(true);
    expect(matchGlob('src/app/**/*.component.ts', 'src/app/features/users/user.component.ts')).toBe(true);
    expect(matchGlob('src/app/**/*.component.ts', 'src/other/user.component.ts')).toBe(false);
  });

  it('matches a trailing "**" as everything under a directory', () => {
    expect(matchGlob('src/app/shared/**', 'src/app/shared/button/button.component.ts')).toBe(true);
    expect(matchGlob('src/app/shared/**', 'src/app/shared/index.ts')).toBe(true);
    expect(matchGlob('src/app/shared/**', 'src/app/other/index.ts')).toBe(false);
  });

  it('matches "?" as a single character', () => {
    expect(matchGlob('src/app/f?o.ts', 'src/app/foo.ts')).toBe(true);
    expect(matchGlob('src/app/f?o.ts', 'src/app/fooo.ts')).toBe(false);
  });

  it('escapes regex-special characters in literal segments', () => {
    expect(matchGlob('src/app/user.service.ts', 'src/app/userXservice.ts')).toBe(false);
  });
});

describe('matchAnyGlob', () => {
  it('is true when at least one pattern matches', () => {
    expect(matchAnyGlob(['src/app/*.service.ts', 'src/app/data/**'], 'src/app/data/http.ts')).toBe(true);
  });

  it('is false when no pattern matches', () => {
    expect(matchAnyGlob(['src/app/*.service.ts', 'src/app/data/**'], 'src/app/ui/button.ts')).toBe(false);
  });

  it('is false for an empty pattern list', () => {
    expect(matchAnyGlob([], 'src/app/anything.ts')).toBe(false);
  });
});
