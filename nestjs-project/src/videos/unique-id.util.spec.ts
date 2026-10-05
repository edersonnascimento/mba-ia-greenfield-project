import { generateUniqueId } from './unique-id.util';

describe('generateUniqueId', () => {
  it('produces a URL-safe string', () => {
    const id = generateUniqueId();
    expect(id.length).toBeGreaterThan(0);
    expect(/^[A-Za-z0-9]+$/.test(id)).toBe(true);
  });

  it('is short (at most 12 characters)', () => {
    expect(generateUniqueId().length).toBeLessThanOrEqual(12);
  });

  it('produces distinct ids across calls', () => {
    expect(generateUniqueId()).not.toBe(generateUniqueId());
  });
});
