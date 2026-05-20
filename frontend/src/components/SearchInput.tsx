import { Search } from 'lucide-react';
import { cn } from './ui/utils';

interface SearchInputProps {
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  className?: string;
}

export function SearchInput({ value, onChange, placeholder = 'Search...', className }: SearchInputProps) {
  return (
    <div className="relative">
      <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">
        <Search className="size-4 text-muted-foreground" />
      </div>
      <input
        type="text"
        placeholder={placeholder}
        className={cn(
          'w-full h-9 pl-9 pr-4 text-sm rounded-md outline-none transition-colors',
          'bg-input-background border border-input text-foreground',
          'placeholder:text-muted-foreground',
          'focus:border-ring',
          className,
        )}
        {...(value !== undefined ? { value } : {})}
        {...(onChange ? { onChange } : {})}
      />
    </div>
  );
}
