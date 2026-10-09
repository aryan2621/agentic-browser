import { useEffect, useId, useRef, useState } from 'react'
import { IconCheck, IconChevronDown } from './Icons'

export interface DropdownOption<T extends string> {
  value: T
  label: string
  description?: string
}

interface Props<T extends string> {
  value: T
  options: Array<DropdownOption<T>>
  onChange: (value: T) => void
  ariaLabel: string
  /** Which edge the menu lines up with (keep it inside narrow containers like the side panel). */
  align?: 'left' | 'right'
  className?: string
}

/**
 * Select with a title and a description per option and a check on the current one. Keyboard:
 * Enter/Space/ArrowDown opens, arrows move, Enter picks, Escape closes.
 */
export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  align = 'left',
  className = ''
}: Props<T>) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const current = options.find((o) => o.value === value) ?? options[0]

  useEffect(() => {
    if (!open) return
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === value)
      )
    )
    const onDown = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open, options, value])

  const pick = (i: number): void => {
    const o = options[i]
    if (o) onChange(o.value)
    setOpen(false)
    button.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!open) {
      if (['Enter', ' ', 'ArrowDown'].includes(e.key)) {
        e.preventDefault()
        setOpen(true)
      }
      return
    }
    if (e.key === 'Escape') {
      // Close only the menu, not the dialog around it (Settings closes on Escape too).
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % options.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i - 1 + options.length) % options.length)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      pick(active)
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <div className={`dropdown ${className}`} ref={root} onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        className="dropdown-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="dropdown-value">{current?.label}</span>
        <IconChevronDown />
      </button>
      {open && (
        <ul
          className={`dropdown-menu align-${align}`}
          role="listbox"
          id={listId}
          aria-label={ariaLabel}
          aria-activedescendant={`${listId}-${active}`}
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={o.value === value}
              className={`dropdown-option ${i === active ? 'active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(i)}
            >
              <span className="dropdown-text">
                <span className="dropdown-label">{o.label}</span>
                {o.description && <span className="dropdown-desc">{o.description}</span>}
              </span>
              {o.value === value && (
                <span className="dropdown-check">
                  <IconCheck />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
