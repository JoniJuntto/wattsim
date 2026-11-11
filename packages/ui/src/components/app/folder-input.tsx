import { type ComponentProps, useId, useMemo } from 'react';
import { Input } from '@/components/ui/input';
import { folderNames } from '@/lib/folders';
import { useLive } from '@/state/live';

/** A text input that suggests the folders already in use; typing a new name makes a new folder. */
export function FolderInput(props: ComponentProps<typeof Input>) {
  const listId = useId();
  const stations = useLive((s) => s.stations);
  const names = useMemo(() => folderNames(Object.values(stations)), [stations]);
  return (
    <>
      <Input list={listId} maxLength={64} autoComplete="off" placeholder="No folder" {...props} />
      <datalist id={listId}>
        {names.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
    </>
  );
}
