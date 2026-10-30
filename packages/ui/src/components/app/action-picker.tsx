import { CheckIcon, ChevronsUpDownIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/** Searchable OCPP action picker. `groups` maps a heading to its actions. */
export function ActionPicker({
  id,
  value,
  onChange,
  groups,
  placeholder = 'Choose an action',
  allowAny,
  className,
}: {
  id?: string;
  value: string;
  onChange: (action: string) => void;
  groups: { heading: string; actions: string[] }[];
  placeholder?: string;
  /** Adds an "Any action" entry that sets the value to ''. */
  allowAny?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const pick = (a: string) => {
    onChange(a);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn('justify-between font-normal', className)}
        >
          <span className={cn('truncate', !value && 'text-muted-foreground')}>
            {value || (allowAny ? 'Any action' : placeholder)}
          </span>
          <ChevronsUpDownIcon data-icon="inline-end" className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search actions" />
          <CommandList>
            <CommandEmpty>No action with that name.</CommandEmpty>
            {allowAny && (
              <CommandGroup>
                <CommandItem value="__any__" onSelect={() => pick('')}>
                  Any action
                  <CheckIcon className={cn('ml-auto', value === '' ? 'opacity-100' : 'opacity-0')} />
                </CommandItem>
              </CommandGroup>
            )}
            {groups
              .filter((g) => g.actions.length > 0)
              .map((g) => (
                <CommandGroup key={g.heading} heading={g.heading}>
                  {g.actions.map((a) => (
                    <CommandItem key={`${g.heading}-${a}`} value={a} onSelect={() => pick(a)}>
                      {a}
                      <CheckIcon className={cn('ml-auto', value === a ? 'opacity-100' : 'opacity-0')} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
