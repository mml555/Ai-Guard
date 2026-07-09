/** Back / Continue footer shared by the wizard's steps. */
export function SetupNav({
  onBack,
  onNext,
  nextLabel = "Continue",
  nextDisabled = false,
}: {
  onBack: () => void;
  onNext: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
}) {
  return (
    <div className="setup-actions">
      <button type="button" className="setup-btn-secondary" onClick={onBack}>
        Back
      </button>
      <button type="button" className="setup-btn-primary" disabled={nextDisabled} onClick={onNext}>
        {nextLabel}
      </button>
    </div>
  );
}
