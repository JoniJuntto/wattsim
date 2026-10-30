/** The run's DLM score: one sentence that reads it, then the figures behind it. */
import type { NodeInfo, SiteScoreView } from '@/api/site-types';
import { SUPPLY_ID } from '@/api/site-types';
import { mainDevice, scoreSentence } from '@/lib/site-model';
import { cn } from '@/lib/utils';

const kwh = (wh: number) => (wh >= 10_000 ? `${(wh / 1000).toFixed(0)} kWh` : `${(wh / 1000).toFixed(1)} kWh`);
const secs = (s: number) =>
  s < 60 ? `${s.toFixed(0)} s` : s < 3600 ? `${(s / 60).toFixed(1)} min` : `${(s / 3600).toFixed(1)} h`;

export function ScoreCard({
  score,
  nodes,
  tripNodes,
  finished,
  className,
}: {
  score: SiteScoreView;
  nodes: readonly NodeInfo[];
  tripNodes: string[];
  /** The run ended: the score is final. */
  finished?: boolean;
  className?: string;
}) {
  const main = mainDevice(nodes, score);
  const mainScore = main ? score.nodes[main] : undefined;
  let over = 0;
  let overAs = 0;
  for (const n of Object.values(score.nodes)) {
    over = Math.max(over, n.secondsOverLimit);
    overAs += n.ampSecondsOverLimit;
  }
  const tiles: Array<{ label: string; value: string; tone?: 'over' | 'near'; title?: string }> = [
    {
      label: main === SUPPLY_ID ? 'Grid peak' : `${main ?? 'Main'} peak`,
      value: mainScore ? `${Math.round(mainScore.peakUtilisationPct)} %` : '–',
      tone:
        mainScore && mainScore.peakUtilisationPct > 100
          ? 'over'
          : mainScore && mainScore.peakUtilisationPct > 80
            ? 'near'
            : undefined,
      title: 'Highest loading of the main protective device, % of its rating',
    },
    { label: 'Trips', value: String(score.trips), tone: score.trips > 0 ? 'over' : undefined },
    {
      label: 'Over a limit',
      value: secs(over),
      tone: over > 0 ? 'over' : undefined,
      title: `Longest time any rated node spent above its rating; ${overAs.toFixed(0)} A·s over in total`,
    },
    { label: 'Delivered', value: kwh(score.energyWh) },
    finished
      ? { label: 'Unmet', value: kwh(score.unmetWh), title: 'Energy the EVs asked for and did not get' }
      : {
          label: 'Still to deliver',
          value: kwh(score.unmetWh),
          title: 'Energy the EVs asked for and have not got yet',
        },
    {
      label: 'Fairness',
      value: score.fairness.mean.toFixed(2),
      title: `Jain index of the allocations, time-weighted (1 = equal shares); lowest ${score.fairness.min.toFixed(2)}`,
    },
    {
      label: 'Imbalance',
      value: `${score.maxImbalanceA.toFixed(0)} A`,
      title: 'Largest phase imbalance at the supply point',
    },
  ];
  return (
    <section aria-label="DLM score" className={cn('flex flex-col gap-2', className)}>
      <p className="text-[13px] leading-snug">
        <span className="font-semibold">{finished ? 'The run: ' : 'So far: '}</span>
        {scoreSentence(score, nodes, { tripNodes })}.
      </p>
      <dl className="grid grid-cols-4 gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-7">
        {tiles.map((t) => (
          <div key={t.label} className="flex flex-col gap-0.5 bg-card px-2.5 py-1.5" title={t.title}>
            <dt className="truncate text-[11px] text-muted-foreground">{t.label}</dt>
            <dd
              className={cn(
                'font-semibold text-base tabular-nums leading-tight',
                t.tone === 'over' && 'text-[var(--load-over)]',
                t.tone === 'near' && 'text-[var(--load-near)]',
              )}
            >
              {t.tone === 'over' ? '▲ ' : ''}
              {t.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
