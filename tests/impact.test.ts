import { describe, it, expect } from 'vitest';
import { day, impact, windows, type Point } from '../packages/impact';
const w = windows('2026-09-01');
function points(page: string, pre: number, post: number): Point[] { return Array.from({ length: 28 }, (_, i) => [{ page_id: page, date: day(w.pre.start, i), value: pre, data_state: 'final' as const }, { page_id: page, date: day(w.post.start, i), value: post, data_state: 'final' as const }]).flat(); }
const input = () => ({ date: '2026-09-01', pages: ['a'], points: points('a', 10, 15), overlaps: [] as string[], status: 'shipped', now: '2026-10-15' });
describe('observational impact', () => {
    it('uses 28/28 days with three excluded days after change', () => expect(w).toEqual({ pre: { start: '2026-08-04', end: '2026-08-31' }, post: { start: '2026-09-05', end: '2026-10-02' }, days: 28, lag: 3 }));
    it('calculates sums and percent change', () => expect(impact(input())).toMatchObject({ pre: 280, post: 420, delta: 140, percent: 50, confidence: 'Directional', scored: true }));
    it('adjusts percent growth with a control', () => expect(impact({ ...input(), control: ['b'], points: [...points('a', 10, 15), ...points('b', 10, 12)] })).toMatchObject({ adjustedPercent: 30.000000000000004, confidence: 'Strong' }));
    it('downgrades overlaps', () => expect(impact({ ...input(), overlaps: ['other'] })).toMatchObject({ confidence: 'Inconclusive', overlaps: ['other'] }));
    it('never scores fresh or missing days', () => { const a = input(); a.points[0].data_state = 'fresh'; expect(impact(a).scored).toBe(false); expect(impact({ ...input(), points: input().points.slice(1) }).scored).toBe(false); });
    it('never scores a future window', () => expect(impact({ ...input(), now: '2026-09-20' }).scored).toBe(false));
    it('never scores a planned, reverted or new-page entry', () => { for (const status of ['planned', 'reverted'])
        expect(impact({ ...input(), status }).scored).toBe(false); expect(impact({ ...input(), newPage: true }).scored).toBe(false); });
    it('does not divide by a zero baseline', () => expect(impact({ ...input(), points: points('a', 0, 10) })).toMatchObject({ percent: null, confidence: 'Inconclusive' }));
    it('labels low volume inconclusive', () => expect(impact({ ...input(), points: points('a', 1, 2) }).confidence).toBe('Inconclusive'));
    it('requires coverage for every treatment and control page', () => { expect(impact({ ...input(), pages: ['a', 'missing'] }).scored).toBe(false); expect(impact({ ...input(), control: ['missing'] }).adjustedPercent).toBeNull(); });
    it('rejects self-controls and invalid windows', () => { expect(() => impact({ ...input(), control: ['a'] })).toThrow(); expect(() => windows('2026-09-01', 0)).toThrow(); expect(() => windows('2026-09-01', 28, -1)).toThrow(); });
    it('handles leap days and year boundaries', () => { expect(day('2024-03-01', -1)).toBe('2024-02-29'); expect(day('2026-01-01', -1)).toBe('2025-12-31'); });
});
it('uses impression-weighted means for CTR', () => { const rows = [...points('a', .1, .2), ...points('b', .3, .4)].map(p => ({ ...p, weight: p.page_id === 'a' ? 1 : 3 })); const result = impact({ ...input(), pages: ['a', 'b'], points: rows, metric: 'ctr' }); expect(result.pre).toBeCloseTo(.25); expect(result.post).toBeCloseTo(.35); expect(result.confidence).toBe('Inconclusive'); });
it('keeps confidence inconclusive when a control disagrees', () => expect(impact({ ...input(), control: ['b'], points: [...points('a', 10, 15), ...points('b', 10, 20)] }).confidence).toBe('Inconclusive'));
