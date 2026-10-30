import { createMDX } from 'fumadocs-mdx/next';

/**
 * GitHub Pages serves a project site under /<repo>; the deploy workflow passes that prefix in DOCS_BASE_PATH.
 * Local builds and `next dev` serve from the root.
 */
const basePath = process.env.DOCS_BASE_PATH?.replace(/\/+$/, '') ?? '';

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  reactStrictMode: true,
  trailingSlash: true,
  basePath: basePath || undefined,
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  images: { unoptimized: true },
};

const withMDX = createMDX();

export default withMDX(config);
