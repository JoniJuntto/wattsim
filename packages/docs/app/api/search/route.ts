import { createFromSource } from 'fumadocs-core/search/server';
import { source } from '@/lib/source';

// Exported once at build time as a static file; the client searches it in the browser.
export const revalidate = false;
export const { staticGET: GET } = createFromSource(source);
