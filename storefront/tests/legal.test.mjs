import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readLegalPublication, selectLegalDocument } from '../lib/legal.ts';
import { legalPath } from '../lib/legal-path.ts';

const date = '2026-06-15';
const prior = '2026-05-24';
const body = title => ({ title, sections: [{ paragraphs: ['Synthetic test paragraph.'] }] });
const edition = label => ({ en: body(label + ' EN'), rw: body(label + ' RW') });
const valid = () => ({
  current: { privacy: date, terms: prior },
  privacy: { [date]: edition('Current'), [prior]: edition('Previous') },
  terms: { [prior]: edition('Terms') },
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'crustcaper-legal-test-'));
  t.after(() => rm(directory, { recursive: true }));
  const path = join(directory, 'publication.json');
  return async (value) => {
    await writeFile(path, Buffer.isBuffer(value) ? value : JSON.stringify(value));
    return readLegalPublication(path);
  };
}

test('a complete publication selects its separate current dates and keeps previous versions reachable', async t => {
  const read = await fixture(t);
  const publication = await read(valid());
  assert.equal(selectLegalDocument(publication, 'privacy', 'rw').document.title, 'Current RW');
  assert.equal(selectLegalDocument(publication, 'privacy', 'en', prior).document.title, 'Previous EN');
  assert.equal(selectLegalDocument(publication, 'terms', 'en').version, prior);
  assert.equal(selectLegalDocument(publication, 'terms', 'en', date), null);
  assert.equal(selectLegalDocument(publication, 'privacy', 'en', 'constructor'), null);
  assert.equal(legalPath('privacy', 'rw', prior), '/privacy/2026-05-24?lang=rw');
});

test('publication rejects incomplete languages, unknown current dates and invalid editions as a unit', async t => {
  const read = await fixture(t);
  const missingLanguage = valid();
  delete missingLanguage.privacy[date].rw;
  const unknownCurrent = valid();
  unknownCurrent.current.terms = date;
  const impossibleDate = valid();
  impossibleDate.terms['2026-02-30'] = edition('Invalid date');
  const emptyTranslation = valid();
  emptyTranslation.privacy[date].en.sections[0].paragraphs = ['   '];
  for (const payload of [missingLanguage, unknownCurrent, impossibleDate, emptyTranslation]) {
    await assert.rejects(read(payload));
  }
});

test('legal loader rejects unsupported encoding and an overlong file', async t => {
  const read = await fixture(t);
  await assert.rejects(read(Buffer.from([0xc0, 0xaf])));
  await assert.rejects(read(Buffer.alloc(512 * 1024 + 1)), /size/);
});
