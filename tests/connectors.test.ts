import { describe, it, expect, vi } from 'vitest';
import { connector } from '../packages/connectors';
import { parseCSV, csvCell } from '../packages/connectors/csv';
import { changeSchema, date, normalizeURL } from '../apps/api/src/service';
describe('fixture boundaries and input validation', () => {
    it('generates both connector series without network', async () => { const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Network forbidden'); }); for (const p of ['gsc', 'ga4']) {
        const rows = await connector(p, 'mock').sync({ propertyId: 'p', pages: [{ id: 'a', url: 'https://cedar.example/' }], date: '2026-10-14', today: '2026-10-15' });
        expect(rows.length).toBeGreaterThan(1);
        expect(rows.every(r => r.data_state === 'fresh')).toBe(true);
    } expect(fetch).not.toHaveBeenCalled(); fetch.mockRestore(); });
    it('blocks live connector mode', () => expect(() => connector('gsc', 'live')).toThrow());
    it('parses quoted fields, CRLF, BOM, multiline and escaped quotes', () => expect(parseCSV('\uFEFFa,b\r\n"hello, world","two\nlines ""quoted"""\r\n')).toEqual([{ a: 'hello, world', b: 'two\nlines "quoted"' }]));
    it('rejects malformed CSV', () => { for (const csv of ['a,a\n1,2', 'a,b\n1', 'a\n"open', 'a\n"done"x'])
        expect(() => parseCSV(csv)).toThrow(); });
    it('escapes spreadsheet formulas', () => expect(csvCell('=1+1')).toBe('"\'=1+1"'));
    it('validates dates and canonicalizes URLs', () => { expect(() => date.parse('2026-02-30')).toThrow(); expect(normalizeURL('https://CEDAR.example/tools/?utm=a#section')).toBe('https://cedar.example/tools/'); expect(() => normalizeURL('javascript:alert(1)')).toThrow(); });
    it('does not accept forged author identity', () => expect(() => changeSchema.parse({ client_id: 'c', occurred_at: '2026-09-01', type: 'content', summary: 'x', rationale: 'y', page_ids: ['p'], author_name: 'Fake' })).toThrow());
});
