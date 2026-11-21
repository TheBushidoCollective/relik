import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseXlsx } from './xlsx.ts';

// openpyxl writes inline strings. The small ZIP rewrite below replaces one of
// its cells with a shared string, preserving all other real-writer parts.
const generator = String.raw`
import datetime, sys, zipfile, xml.etree.ElementTree as ET
import openpyxl
from openpyxl.utils.datetime import CALENDAR_MAC_1904
p, q = sys.argv[1:]
w = openpyxl.Workbook(); w.epoch = CALENDAR_MAC_1904
s = w.active; s.title = 'Orders'
s.append(['Name', 'Date', 'Percent', 'Formula'])
s.append(['Shared value', datetime.datetime(2024, 1, 2), 0.25, '=C2*2'])
s['C2'].number_format = '0.00%'
w.create_sheet('Hidden').sheet_state = 'hidden'
w.save(p)
ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
rels = 'http://schemas.openxmlformats.org/package/2006/relationships'
types = 'http://schemas.openxmlformats.org/package/2006/content-types'
with zipfile.ZipFile(p) as source, zipfile.ZipFile(q, 'w') as out:
 for info in source.infolist():
  data = source.read(info.filename)
  if info.filename == 'xl/worksheets/sheet1.xml':
   root = ET.fromstring(data); cell = root.find('.//{%s}c[@r="A2"]' % ns)
   cell.set('t', 's'); cell.remove(cell.find('{%s}is' % ns))
   ET.SubElement(cell, '{%s}v' % ns).text = '0'
   data = ET.tostring(root, encoding='utf-8', xml_declaration=True)
  elif info.filename == 'xl/_rels/workbook.xml.rels':
   root = ET.fromstring(data)
   ET.SubElement(root, '{%s}Relationship' % rels, Id='shared-test', Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings', Target='sharedStrings.xml')
   data = ET.tostring(root, encoding='utf-8', xml_declaration=True)
  elif info.filename == '[Content_Types].xml':
   root = ET.fromstring(data)
   ET.SubElement(root, '{%s}Override' % types, PartName='/xl/sharedStrings.xml', ContentType='application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml')
   data = ET.tostring(root, encoding='utf-8', xml_declaration=True)
  out.writestr(info, data)
 out.writestr('xl/sharedStrings.xml', '<sst xmlns="%s"><si><r><t>Shared </t></r><r><t>value</t></r></si></sst>' % ns)
`;
const available = spawnSync('python3', ['-c', 'import openpyxl']).status === 0;

test.skipIf(!available)(
  'reads an openpyxl 1904 workbook with shared strings and a hidden sheet',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relic-xlsx-openpyxl-'));
    try {
      const raw = join(dir, 'original.xlsx'),
        file = join(dir, 'shared.xlsx');
      const generated = spawnSync('python3', ['-c', generator, raw, file], {
        encoding: 'utf8',
      });
      expect(generated.status).toBe(0);
      if (generated.status !== 0) throw new Error(generated.stderr);
      const parsed = await parseXlsx(new Uint8Array(readFileSync(file)));
      if (!parsed.ok) throw new Error(parsed.reason);
      expect(parsed.workbook.date1904).toBe(true);
      const [orders, hidden] = parsed.workbook.sheets;
      expect(hidden?.state).toBe('hidden');
      expect(orders?.texts).toEqual([
        'Name',
        'Date',
        'Percent',
        'Formula',
        'Shared value',
        '2024-01-02',
        '25%',
        '',
      ]);
      expect(orders?.details.some((detail) => detail.formula === 'C2*2')).toBe(
        true
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);
