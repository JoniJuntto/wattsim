import { type TimeWindow, WINDOWS } from '@/api/charts';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

/** The time range control: one row, left-aligned, above the charts it scopes. */
export function WindowPicker({
  value,
  onChange,
  label = 'Time window',
}: {
  value: TimeWindow;
  onChange: (w: TimeWindow) => void;
  label?: string;
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={value}
      onValueChange={(v) => {
        if (v) onChange(v as TimeWindow);
      }}
      aria-label={label}
    >
      {WINDOWS.map((w) => (
        <ToggleGroupItem
          key={w.value}
          value={w.value}
          className="px-2.5 text-xs"
          title={w.value === 'all' ? 'Everything kept (24 h)' : `Last ${w.label}`}
        >
          {w.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
