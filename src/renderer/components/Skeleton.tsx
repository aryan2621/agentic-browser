/** Placeholder lines shown while the answer is being prepared. */
export function AnswerSkeleton() {
  return (
    <div className="skeleton-block" aria-hidden="true">
      <span className="skeleton-line" style={{ width: '96%' }} />
      <span className="skeleton-line" style={{ width: '88%' }} />
      <span className="skeleton-line" style={{ width: '62%' }} />
      <span className="skeleton-line heading" style={{ width: '28%' }} />
      <span className="skeleton-line" style={{ width: '92%' }} />
      <span className="skeleton-line" style={{ width: '84%' }} />
      <span className="skeleton-line" style={{ width: '90%' }} />
      <span className="skeleton-line" style={{ width: '70%' }} />
    </div>
  )
}
