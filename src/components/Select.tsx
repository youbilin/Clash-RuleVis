import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { cx } from '../lib/misc';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectGroup {
  label: string;
  options: SelectOption[];
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options?: SelectOption[];
  groups?: SelectGroup[];
  placeholder?: string;
  compact?: boolean;
  disabled?: boolean;
  className?: string;
  menuClassName?: string;
  ariaLabel?: string;
  title?: string;
  style?: CSSProperties;
}

interface PopupPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  up: boolean;
}

export function Select({
  value,
  onChange,
  options = [],
  groups,
  placeholder = '请选择',
  compact,
  disabled,
  className,
  menuClassName,
  ariaLabel,
  title,
  style,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<PopupPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const typeahead = useRef({ query: '', at: 0 });
  const id = useId();

  const baseGroups: SelectGroup[] = groups?.length ? groups : [{ label: '', options }];
  const definedOptions = baseGroups.flatMap((group) => group.options);
  const missingCurrent = value !== '' && !definedOptions.some((option) => option.value === value);
  const groupList: SelectGroup[] = missingCurrent
    ? [{ label: '', options: [{ value, label: value }] }, ...baseGroups]
    : baseGroups;
  const flat = groupList.flatMap((group) => group.options);
  const current = flat.find((option) => option.value === value);
  const currentIndex = flat.findIndex((option) => option.value === value);

  const positionPopup = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportGap = 10;
    const desiredWidth = Math.max(rect.width, 168);
    const width = Math.min(desiredWidth, window.innerWidth - viewportGap * 2);
    const below = window.innerHeight - rect.bottom - viewportGap;
    const above = rect.top - viewportGap;
    const up = below < 190 && above > below;
    const maxHeight = Math.max(120, Math.min(300, up ? above : below) - 4);
    const left = Math.min(Math.max(viewportGap, rect.left), window.innerWidth - width - viewportGap);
    const top = up ? rect.top - 6 : rect.bottom + 6;
    setPosition({ left, top, width, maxHeight, up });
  };

  const close = (restoreFocus = false) => {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) triggerRef.current?.focus();
  };

  const openMenu = (direction: 1 | -1 = 1) => {
    if (disabled) return;
    const firstEnabled = flat.findIndex((option) => !option.disabled);
    const base = currentIndex >= 0 ? currentIndex : direction > 0 ? firstEnabled : -1;
    setActiveIndex(base);
    positionPopup();
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) return;
      close();
    };
    const onScroll = (event: Event) => {
      if (popupRef.current?.contains(event.target as Node)) return;
      close();
    };
    const onResize = () => close();
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const option = popupRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    option?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  const commit = (option: SelectOption) => {
    if (option.disabled) return;
    onChange(option.value);
    close(true);
  };

  const move = (step: 1 | -1) => {
    if (!flat.length) return;
    let next = activeIndex;
    for (let attempt = 0; attempt < flat.length; attempt += 1) {
      next = (next + step + flat.length) % flat.length;
      if (!flat[next]?.disabled) break;
    }
    setActiveIndex(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) openMenu(event.key === 'ArrowDown' ? 1 : -1);
      else move(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      if (!open) return;
      event.preventDefault();
      const ordered = event.key === 'Home'
        ? flat.map((_, index) => index)
        : flat.map((_, index) => flat.length - 1 - index);
      const target = ordered.find((index) => !flat[index]?.disabled);
      if (target !== undefined) setActiveIndex(target);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) openMenu();
      else if (flat[activeIndex] && !flat[activeIndex].disabled) commit(flat[activeIndex]);
      return;
    }
    if (event.key === 'Escape') {
      if (!open) return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === 'Tab') {
      if (open) close();
      return;
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = Date.now();
      const query = now - typeahead.current.at > 650
        ? event.key.toLowerCase()
        : `${typeahead.current.query}${event.key.toLowerCase()}`;
      typeahead.current = { query, at: now };
      const match = flat.findIndex((option) => !option.disabled && option.label.toLowerCase().startsWith(query));
      if (match >= 0) {
        if (!open) openMenu();
        setActiveIndex(match);
      }
    }
  };

  const triggerId = `select-trigger-${id}`;
  const listId = `select-list-${id}`;
  const activeOption = open ? flat[activeIndex] : undefined;

  return (
    <>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={activeOption ? `${listId}-${activeIndex}` : undefined}
        aria-label={ariaLabel}
        title={title}
        className={cx('select-trigger', compact && 'compact', open && 'open', className)}
        style={style}
        disabled={disabled}
        onClick={() => {
          if (open) close();
          else openMenu();
        }}
        onKeyDown={onKeyDown}
      >
        <span className={cx('select-value', !current && 'placeholder')}>{current?.label ?? placeholder}</span>
        <ChevronDown className="select-chevron" size={14} strokeWidth={1.9} />
      </button>
      {open && position
        ? createPortal(
            <div
              ref={popupRef}
              id={listId}
              role="listbox"
              aria-labelledby={triggerId}
              className={cx('select-popup', menuClassName)}
              style={{
                left: position.left,
                top: position.top,
                width: position.width,
                maxHeight: position.maxHeight,
                transform: position.up ? 'translateY(-100%)' : undefined,
              }}
            >
              {flat.length === 0 ? <div className="select-empty">没有可选项</div> : null}
              {groupList.map((group, groupIndex) => {
                const offset = groupList
                  .slice(0, groupIndex)
                  .reduce((sum, item) => sum + item.options.length, 0);
                return (
                  <div key={`${group.label}-${groupIndex}`} className="select-group">
                    {group.label ? <div className="select-group-label">{group.label}</div> : null}
                    {group.options.map((option, optionIndex) => {
                      const index = offset + optionIndex;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="option"
                          id={`${listId}-${index}`}
                          data-index={index}
                          tabIndex={-1}
                          aria-selected={option.value === value}
                          disabled={option.disabled}
                          className={cx(
                            'select-option',
                            option.value === value && 'selected',
                            index === activeIndex && 'active',
                          )}
                          onMouseEnter={() => setActiveIndex(index)}
                          onClick={() => commit(option)}
                        >
                          <span className="select-option-label">{option.label}</span>
                          {option.value === value ? <Check size={13} className="select-check" /> : null}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
