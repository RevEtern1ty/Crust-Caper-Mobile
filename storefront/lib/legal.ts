import { open } from 'node:fs/promises';
import { z } from 'zod';
import type { Locale } from './catalog-types.ts';
import type { LegalKind } from './legal-path.ts';

const maxPublicationBytes = 512 * 1024;
const versionDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
});
const paragraph = z.string().trim().min(1);
const translation = z.strictObject({
  title: paragraph,
  sections: z.array(z.strictObject({
    heading: paragraph.optional(),
    paragraphs: z.array(paragraph).min(1),
  })).min(1),
});
const documents = z.record(versionDate, z.strictObject({ en: translation, rw: translation }));
const publication = z.strictObject({
  current: z.strictObject({ privacy: versionDate, terms: versionDate }),
  privacy: documents,
  terms: documents,
}).refine(value => Object.hasOwn(value.privacy, value.current.privacy) && Object.hasOwn(value.terms, value.current.terms));

export type LegalDocument = z.infer<typeof translation>;
type Publication = z.infer<typeof publication>;
type PublicationState = { status: 'disabled' | 'unavailable' } | { status: 'published'; publication: Publication };

export async function readLegalPublication(path: string): Promise<Publication> {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxPublicationBytes) throw new Error('Invalid legal publication size');

    // A deployment mounts a bounded plain-text manifest. React renders its content as text.
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size) throw new Error('Legal publication changed while loading');
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
    return publication.parse(JSON.parse(source));
  } finally {
    await file.close();
  }
}

let mountedPublication: Promise<PublicationState> | undefined;

export function legalPublication(): Promise<PublicationState> {
  const path = process.env.CRUSTCAPER_LEGAL_PUBLICATION_FILE;
  if (!path) return Promise.resolve({ status: 'disabled' });
  // The publication is read-only. A new edition is mounted with a catalog restart.
  return mountedPublication ??= readLegalPublication(path).then(
    value => ({ status: 'published', publication: value }),
    () => ({ status: 'unavailable' }),
  );
}

export function selectLegalDocument(published: Publication, kind: LegalKind, locale: Locale, version?: string) {
  const current = published.current[kind];
  const requested = version ?? current;
  if (!Object.hasOwn(published[kind], requested)) return null;
  return { current, version: requested, document: published[kind][requested][locale] };
}
