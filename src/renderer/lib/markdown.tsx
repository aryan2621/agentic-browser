import { createContext, Fragment, useContext, type ReactNode } from 'react'
import { openInNewTab } from './api'

/** What clicking a link in rendered Markdown does (default: open it in a new browser tab). */
export const LinkHandlerContext = createContext<(href: string) => void>(openInNewTab)

/**
 * Minimal, safe Markdown renderer (no HTML injection: everything becomes React elements).
 * Supports headings, lists, blockquotes, fenced code, paragraphs, bold/italic, inline code, links.
 */
export function Markdown({ text }: { text: string }): ReactNode {
  return <div className="md">{renderBlocks(text)}</div>
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  const re =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\s][^*]*\*)|(_[^_\s][^_]*_)|(\[[^\]]+\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g
  let last = 0
  let i = 0
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0
    if (idx > last) out.push(text.slice(last, idx))
    const key = `${keyPrefix}-${i++}`
    const token = m[0]
    if (m[1]) out.push(<code key={key}>{token.slice(1, -1)}</code>)
    else if (m[2] || m[3]) out.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    else if (m[4] || m[5]) out.push(<em key={key}>{token.slice(1, -1)}</em>)
    else if (m[6]) {
      const label = /^\[([^\]]+)\]/.exec(token)?.[1] ?? token
      const href = m[7]!
      out.push(<LinkButton key={key} href={href} label={label} />)
    } else if (m[8]) out.push(<LinkButton key={key} href={token} label={token} />)
    last = idx + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function LinkButton({ href, label }: { href: string; label: string }): ReactNode {
  const open = useContext(LinkHandlerContext)
  return (
    <a
      href={href}
      className={/^\d{1,2}$/.test(label) ? 'cite' : undefined}
      onClick={(e) => {
        e.preventDefault()
        open(href)
      }}
      title={href}
    >
      {label}
    </a>
  )
}

function renderBlocks(text: string): ReactNode[] {
  const lines = text.replace(/\r/g, '').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let k = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (/^\s*```/.test(line)) {
      const code: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) code.push(lines[i++]!)
      i++
      blocks.push(
        <pre key={k++}>
          <code>{code.join('\n')}</code>
        </pre>
      )
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      const level = Math.min(h[1]!.length + 1, 6)
      const Tag = `h${level}` as 'h2'
      blocks.push(<Tag key={k++}>{renderInline(h[2]!, `h${k}`)}</Tag>)
      i++
      continue
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i]!))
        quote.push(lines[i++]!.replace(/^\s*>\s?/, ''))
      blocks.push(<blockquote key={k++}>{renderInline(quote.join(' '), `q${k}`)}</blockquote>)
      continue
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line)
      const items: string[] = []
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]!)) {
        let item = lines[i++]!.replace(/^\s*([-*+]|\d+[.)])\s+/, '')
        // continuation lines
        while (
          i < lines.length &&
          /^\s{2,}\S/.test(lines[i]!) &&
          !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]!)
        )
          item += ' ' + lines[i++]!.trim()
        items.push(item)
      }
      const List = ordered ? 'ol' : 'ul'
      blocks.push(
        <List key={k++}>
          {items.map((it, j) => (
            <li key={j}>{renderInline(it, `l${k}-${j}`)}</li>
          ))}
        </List>
      )
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^(#{1,6}\s|\s*>|\s*```|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]!)
    )
      para.push(lines[i++]!)
    blocks.push(
      <p key={k++}>
        {para.map((p, j) => (
          <Fragment key={j}>
            {j > 0 && ' '}
            {renderInline(p, `p${k}-${j}`)}
          </Fragment>
        ))}
      </p>
    )
  }
  return blocks
}
