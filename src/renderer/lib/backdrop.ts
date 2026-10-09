import { useRef, type HTMLAttributes } from 'react'

/**
 * Props for a modal's backdrop: a click on the backdrop itself closes the modal. Both the press
 * and the release must land on the backdrop, so a text selection that ends outside the dialog
 * doesn't close it.
 */
export function useBackdropClose(
  onClose: () => void
): Pick<HTMLAttributes<HTMLElement>, 'onMouseDown' | 'onClick'> {
  const pressed = useRef(false)
  return {
    onMouseDown: (e) => {
      pressed.current = e.target === e.currentTarget
    },
    onClick: (e) => {
      if (pressed.current && e.target === e.currentTarget) onClose()
      pressed.current = false
    }
  }
}
