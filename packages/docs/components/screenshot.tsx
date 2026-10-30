import { asset } from '@/lib/shared';

type Props = {
  /** File name under public/screenshots without the -light / -dark suffix and extension, e.g. "fleet". */
  name: string;
  alt: string;
};

const base = 'rounded-lg border shadow-sm my-0 w-full h-auto';

function Png({ file, alt, className }: { file: string; alt: string; className: string }) {
  return (
    // biome-ignore lint/performance/noImgElement: a static export with unoptimized images; next/image adds nothing here
    <img src={asset(`/screenshots/${file}.png`)} alt={alt} className={`${base} ${className}`} loading="lazy" />
  );
}

/** A UI screenshot that follows the site theme: the light capture in light mode, the dark one in dark mode. */
export function Screenshot({ name, alt }: Props) {
  return (
    <figure className="my-6">
      <Png file={`${name}-light`} alt={alt} className="dark:hidden" />
      <Png file={`${name}-dark`} alt={alt} className="hidden dark:block" />
    </figure>
  );
}
